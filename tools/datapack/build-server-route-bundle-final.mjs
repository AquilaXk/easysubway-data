#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";

import {
  canonicalJson,
  sha256,
  signingKeyId,
  signingPublicKey,
  validateArtifactComponentManifest,
  verifyRsaSha256Signature,
  withoutSignature,
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
  canonicalRideEdgeSetSha256,
  canonicalRouteEdgeEvaluationJson,
  evaluateRouteAccessibilityEdges,
  routeRequiredCellStateSummary,
} from "./evaluate-route-accessibility-edges.mjs";
import { GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL } from "./emit-artifact-components.mjs";
import {
  buildTransitionFacilityRequirements,
  readBundledStepFreeInputs,
  sortTransitionFacilityRequirements,
  validateTransitionFacilityRequirements,
} from "./build-step-free-path-transitions.mjs";
import { parseArgs, requiredArg } from "./lib/cli-args.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import { validatePublicationReceipt } from "./publish-server-route-bundle.mjs";
import { validateRequest } from "../release/validate-promotion-request.mjs";
import { validateSourceSnapshotFreshness } from "./validate-source-snapshot-freshness.mjs";

const KEYLESS_ARTIFACT_ROOT_FILES = ["compatibility.json", "manifest.signing-input.json", "payload", "provenance.json"];
const SIGNED_ARTIFACT_ROOT_FILES = ["compatibility.json", "manifest.json", "manifest.signing-input.json", "payload", "provenance.json"];
const COMPONENTS = ["accessibility", "fare", "timetable", "topology"];
const SIGNATURE_ALGORITHM = "rsa-sha256-server-route-bundle-v1";
const PAYLOAD_FILES = COMPONENTS.map((component) => `${component}.sqlite.zst`);
const OUTPUT_FILES = [
  "artifact-inventory.json",
  "route-edge-evaluation.json",
  "source-freshness.json",
  "station-line-accessibility.json",
];
const BASE_CLI_KEYS = [
  "artifact-root", "evaluation-at", "output", "repository-git-sha", "route-edge-input", "station-line-input",
];
const ELIGIBILITY_CLI_KEY = "eligibility-report";
const RELEASE_CLI_KEYS = [
  "approval-evidence", "compatibility-evidence", "promotion-component", "promotion-inventory",
  "promotion-request", "promotion-workflow-run-id", "publication-receipt", "candidate-execution-evidence-root",
];
const RELEASE_EVIDENCE_KEYS = [
  "approvalEvidencePath", "compatibilityEvidencePath", "promotionComponentPath", "promotionInventoryPath",
  "promotionRequestPath", "promotionWorkflowRunId", "publicationReceiptPath", "candidateExecutionEvidenceRoot",
];
const RECEIPT_CANDIDATE_KEYS = [
  "bundleId", "releaseSequence", "stationSetSha256", "sourceSnapshotSetHash", "signingInputSha256",
  "signedManifestRawSha256", "payloadRootSha256", "componentInventorySha256", "componentDigests",
  "activeFrom", "freshUntil", "keyId",
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

export const E_SERVER_BUNDLE_DECOMPRESSED_BUDGET = "E_SERVER_BUNDLE_DECOMPRESSED_BUDGET";

export function evaluateDecompressedBudget(payloadBytesByComponent, maxTotalBytes) {
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new Error("maxTotalBytes must be a positive integer");
  }
  const components = {};
  let totalBytes = 0;
  for (const component of COMPONENTS) {
    const compressedBytes = payloadBytesByComponent[component];
    if (!compressedBytes || !Buffer.isBuffer(compressedBytes)) {
      throw new Error(`missing or invalid payload bytes for ${component}`);
    }
    let decompressed;
    try {
      decompressed = zstdDecompressSync(compressedBytes);
    } catch (cause) {
      throw new Error(`failed to decompress ${component} payload`, { cause });
    }
    const byteLength = decompressed.length;
    components[component] = byteLength;
    totalBytes += byteLength;
  }

  const headroomBytes = maxTotalBytes - totalBytes;
  const headroomRatio = maxTotalBytes === 0 ? 0 : headroomBytes / maxTotalBytes;

  if (totalBytes > maxTotalBytes) {
    const error = new Error(
      `${E_SERVER_BUNDLE_DECOMPRESSED_BUDGET}: total decompressed bytes ${totalBytes} exceeds budget ${maxTotalBytes} (headroom: ${headroomBytes} bytes)`,
    );
    error.code = E_SERVER_BUNDLE_DECOMPRESSED_BUDGET;
    error.details = {
      components,
      totalBytes,
      maxTotalBytes,
      headroomBytes,
      headroomRatio,
    };
    throw error;
  }

  return {
    components,
    totalBytes,
    maxTotalBytes,
    headroomBytes,
    headroomRatio,
  };
}

export async function buildServerRouteBundleFinalEvidence(input) {
  if (input.beforeReleaseOutput !== undefined && typeof input.beforeReleaseOutput !== "function") {
    throw new Error("beforeReleaseOutput must be a function");
  }
  if (input.clock !== undefined && typeof input.clock !== "function") {
    throw new Error("clock must be a function");
  }
  const repositoryRoot = await realDirectory(input.repositoryRoot ?? process.cwd(), "repository root");
  const artifactRoot = await realDirectory(input.artifactRoot, "artifact root");
  const output = path.resolve(requiredRaw(input.output, "output"));
  await requireNewOutput(output);
  const outputParent = await realDirectory(path.dirname(output), "output parent");
  const evaluationAt = new Date(requiredUtcInstant(input.evaluationAt, "evaluationAt")).toISOString();
  const repositoryGitSha = await verifiedRepositoryGitSha(repositoryRoot, input.repositoryGitSha);

  const fixed = await readFixedInputs(repositoryRoot);
  const candidateId = requiredRaw(fixed.buildSpec.value.candidateId, "build spec candidate id");
  const maxTotalDecompressedBytes = input.maxTotalDecompressedBytes ?? fixed.buildContract.value.maxTotalDecompressedBytes;
  const artifact = await inspectArtifact(artifactRoot, fixed, maxTotalDecompressedBytes);
  const sourceFreshness = evaluateSourceFreshness({ fixed, artifact, evaluationAt });
  // #913 후속: 발행 전 FINAL(RC)도 발행 경로와 같은 입력으로 원천 신선도 cutoff를 검사한다.
  // seq126은 RC에서 이 검사를 건너뛰어 production-publish에서야 실패했다.
  if (sourceFreshness.state === "PASS") assertSourceFreshnessCoversCandidate(sourceFreshness, artifact.manifest.freshUntil);
  const stationLineInput = validateStationLineInput(input.stationLineInput, artifact, candidateId);
  const materialization = materializeStationLineAccessibility({
    ...stationLineInput,
    observedAt: evaluationAt,
  });
  const routeEdgeInput = validateRouteEdgeInput(
    input.routeEdgeInput,
    artifact,
    candidateId,
    stationLineInput.candidate.stationSetSha256,
  );
  const evaluation = evaluateRouteAccessibilityEdges({
    ...routeEdgeInput,
    evaluationAt,
    materialization,
  }, fixed.routeEdgePolicy.value);

  const sourceFreshnessBytes = Buffer.from(canonicalJson(sourceFreshness.evidence));
  const artifactInventoryBytes = Buffer.from(canonicalJson(artifact.evidence));
  const materializationBytes = Buffer.from(canonicalStationLineAccessibilityJson(materialization));
  const evaluationBytes = Buffer.from(canonicalRouteEdgeEvaluationJson(evaluation));
  await assertEmbeddedEvidence({
    accessibilityPayloadBytes: artifact.accessibilityPayloadBytes,
    topologyPayloadBytes: artifact.topologyPayloadBytes,
    transferStairSnapshotId: admittedTransferStairSnapshotId(fixed.sourceInventory.value),
    routeEdges: routeEdgeInput.routeEdges,
    evaluation,
    evaluationBytes,
    materialization,
    materializationBytes,
    outputParent,
  });
  const candidate = {
      repository: "AquilaXk/easysubway-data",
      gitSha: repositoryGitSha,
      bundleId: artifact.manifest.bundleId,
      releaseSequence: artifact.manifest.releaseSequence,
      stationSetSha256: artifact.manifest.stationSetSha256,
      sourceSnapshotSetHash: artifact.provenance.sourceSnapshotSetHash,
      signingInputSha256: artifact.signingInputSha256,
      signedManifestRawSha256: artifact.signedManifestRawSha256,
      payloadRootSha256: artifact.manifest.payloadSha256,
      componentInventorySha256: artifact.componentInventorySha256,
      componentDigests: Object.fromEntries(COMPONENTS.map((component) => [
        component,
        artifact.manifest[`${component}Sha256`],
      ])),
      activeFrom: artifact.manifest.activeFrom,
      freshUntil: artifact.manifest.freshUntil,
      keyId: artifact.manifest.keyId,
  };
  const eligibility = await routeAccessibilityEligibilityGate({
    reportPath: input.eligibilityReportPath,
    candidate,
    materialization,
    materializationBytes,
    evaluation,
    evaluationBytes,
  });
  const prePublicationFinal = buildServerRouteBundleFinal({
    candidate,
    gates: {
      sourceFreshness: { state: sourceFreshness.state, evidenceSha256: sha256(sourceFreshnessBytes) },
      stationLineAccessibility: {
        // #873: 평가가 요구한 cell(환승 끝점 TRANSFER 등)만 닫혀 있어야 한다. 근거 파일은 materialization 전체다.
        state: stationLineGateState(routeRequiredCellStateSummary(evaluation)),
        evidenceSha256: sha256(materializationBytes),
      },
      routeEdgeEvaluation: {
        state: routeEdgeGateState(evaluation),
        evidenceSha256: sha256(evaluationBytes),
      },
      routeAccessibilityEligibility: eligibility.gate,
      artifactInventory: { state: "PASS", evidenceSha256: sha256(artifactInventoryBytes) },
      signature: artifact.signedManifestRawSha256 === null
        ? { state: "UNAVAILABLE", evidenceSha256: null }
        : { state: "PASS", evidenceSha256: artifact.signedManifestRawSha256 },
      publication: { state: "UNAVAILABLE", evidenceSha256: null },
      promotionAuthorization: { state: "UNAVAILABLE", evidenceSha256: null },
    },
  });
  const release = input.releaseEvidence === undefined
    ? null
    : await closeReleaseFinal(
      prePublicationFinal,
      input.releaseEvidence,
      artifact.publicationObjects,
      sourceFreshness,
    );
  if (release !== null && eligibility.file !== null) release.files.push(eligibility.file);
  const final = release?.final ?? prePublicationFinal;
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
    if (release !== null) {
      await input.beforeReleaseOutput?.();
      await assertEvidenceFilesUnchanged(release.files);
      assertReleaseCandidateFresh(final.candidate.freshUntil, (input.clock ?? Date.now)());
    }
    await rename(temp, output);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
  return final;
}

// 발행 단계 FINAL 종료. 테스트가 발행 전 검사와 별개로 이 단계의 가드를 직접 겨누도록 export한다(#916 리뷰 F1).
export async function closeReleaseFinal(prePublicationFinal, releaseEvidence, publicationObjects, sourceFreshness) {
  if (prePublicationFinal.result !== "NO_GO"
    || canonicalJson(prePublicationFinal.blockers) !== canonicalJson([
      "promotionAuthorization:UNAVAILABLE",
      "publication:UNAVAILABLE",
    ])) {
    throw new Error("pre-publication FINAL is not release eligible");
  }
  assertSourceFreshnessCoversCandidate(sourceFreshness, prePublicationFinal.candidate.freshUntil);
  assertKeys(releaseEvidence, RELEASE_EVIDENCE_KEYS, "release evidence keys");
  const paths = Object.fromEntries(RELEASE_EVIDENCE_KEYS
    .filter((key) => key.endsWith("Path"))
    .map((key) => [key, path.resolve(requiredRaw(releaseEvidence[key], key))]));
  const executionEvidence = await snapshotCandidateExecutionEvidence(
    requiredRaw(releaseEvidence.candidateExecutionEvidenceRoot, "candidateExecutionEvidenceRoot"),
  );
  const allPaths = [...Object.values(paths), ...executionEvidence.files.map((file) => file.target)];
  if (new Set(allPaths).size !== allPaths.length) {
    throw new Error("release evidence paths must be distinct");
  }
  const files = [
    ...await Promise.all(Object.entries(paths).map(async ([key, target]) => ({
    key,
    target,
    bytes: await readNonEmptyRegular(target, key),
    }))),
    ...executionEvidence.files,
  ];
  const bytes = Object.fromEntries(files.map((entry) => [entry.key, entry.bytes]));
  const publicationReceipt = validatePublicationReceipt(parseCanonicalJson(
    bytes.publicationReceiptPath,
    "publication receipt",
  ));
  assertReceiptCandidate(prePublicationFinal, publicationReceipt, publicationObjects);

  const promotionRequest = parseCanonicalOrFormattedJson(bytes.promotionRequestPath, "promotion request");
  const promotionComponent = parseCanonicalOrFormattedJson(bytes.promotionComponentPath, "promotion component");
  const promotionInventory = parseCanonicalOrFormattedJson(bytes.promotionInventoryPath, "promotion inventory");
  const compatibilityEvidence = parseCanonicalOrFormattedJson(
    bytes.compatibilityEvidencePath,
    "compatibility evidence",
  );
  validateRequest({
    request: promotionRequest,
    component: promotionComponent,
    inventory: promotionInventory,
    inventoryBytes: bytes.promotionInventoryPath,
    compatibility: compatibilityEvidence,
    compatibilityBytes: bytes.compatibilityEvidencePath,
    ...executionEvidence,
    approvalBytes: bytes.approvalEvidencePath,
    workflowRunId: requiredRaw(releaseEvidence.promotionWorkflowRunId, "promotionWorkflowRunId"),
  });
  assertPromotionCandidate(prePublicationFinal, promotionComponent, promotionInventory, publicationReceipt);

  return {
    final: buildServerRouteBundleFinal({
      candidate: prePublicationFinal.candidate,
      gates: {
        ...prePublicationFinal.gates,
        publication: { state: "PASS", evidenceSha256: sha256(bytes.publicationReceiptPath) },
        promotionAuthorization: { state: "PASS", evidenceSha256: sha256(bytes.promotionRequestPath) },
      },
    }),
    files,
  };
}

function assertReceiptCandidate(prePublicationFinal, receipt, publicationObjects) {
  if (receipt.repository.name !== prePublicationFinal.candidate.repository
    || receipt.repository.gitSha !== prePublicationFinal.candidate.gitSha
    || receipt.candidate.prePublicationFinalSha256 !== prePublicationFinal.finalSha256) {
    throw new Error("publication receipt FINAL identity mismatch");
  }
  for (const key of RECEIPT_CANDIDATE_KEYS) {
    if (canonicalJson(receipt.candidate[key]) !== canonicalJson(prePublicationFinal.candidate[key])) {
      throw new Error(`publication receipt candidate ${key} mismatch`);
    }
  }
  const receiptObjects = receipt.objects.map(({ path: objectPath, sizeBytes, sha256: digest }) => ({
    path: objectPath,
    sizeBytes,
    sha256: digest,
  }));
  if (canonicalJson(receiptObjects) !== canonicalJson(publicationObjects)) {
    throw new Error("publication receipt object inventory mismatch");
  }
}

function assertSourceFreshnessCoversCandidate(sourceFreshness, freshUntil) {
  const results = sourceFreshness?.evidence?.validation?.results;
  if (sourceFreshness?.state !== "PASS" || !Array.isArray(results) || results.length === 0) {
    throw new Error("source freshness cutoff evidence is unavailable");
  }
  const candidateCutoff = Date.parse(freshUntil);
  if (!Number.isFinite(candidateCutoff)) throw new Error("candidate freshUntil is invalid");
  // #913: nationwide 예외(#761)를 없앤다. 번들 freshUntil이 이제 시간표 원천 만료까지 반영하므로(build-datapack),
  // 인용 원천 중 하나라도 번들보다 먼저 만료되면 원천이 만료된 데이터를 서빙하게 된다.
  for (const result of results) {
    if (requiredUtcInstant(result.freshnessExpiresAt, "source freshness cutoff") < candidateCutoff) {
      throw new Error("source freshness cutoff must cover candidate freshUntil");
    }
  }
}

function assertPromotionCandidate(final, component, inventory, receipt) {
  if (component.gitSha !== final.candidate.gitSha
    || component.releaseSequence !== final.candidate.releaseSequence
    || component.provenance.sourceSnapshotSetHash !== final.candidate.sourceSnapshotSetHash) {
    throw new Error("promotion candidate identity mismatch");
  }
  const actual = inventory.entries.filter((entry) => (
    entry.path.startsWith("server-route-bundle/")
    && entry.path !== "server-route-bundle/manifest.json"
  ));
  const expected = receipt.objects
    .filter((entry) => entry.path !== "manifest.json")
    .map((entry) => ({
      path: `server-route-bundle/${entry.path}`,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
    }));
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("promotion server-route-bundle inventory mismatch");
  }
}

async function assertEvidenceFilesUnchanged(files) {
  for (const file of files) {
    const current = await readNonEmptyRegular(file.target, file.key);
    if (!current.equals(file.bytes)) throw new Error(`${file.key} changed during FINAL build`);
  }
}

async function snapshotCandidateExecutionEvidence(root) {
  const target = await realDirectory(root, "candidate execution evidence");
  await assertDirectoryEntries(
    target,
    ["release-decision.json", "release-evidence-bundle.json"],
    "candidate execution evidence file set",
  );
  const files = await Promise.all([
    ["candidateReleaseDecisionPath", "release-decision.json", "candidate execution evidence/release-decision.json"],
    ["candidateReleaseEvidenceBundlePath", "release-evidence-bundle.json", "candidate execution evidence/release-evidence-bundle.json"],
  ].map(async ([key, name, label]) => {
    const file = path.join(target, name);
    return { key, target: file, bytes: await readNonEmptyRegular(file, label) };
  }));
  const bytes = Object.fromEntries(files.map((file) => [file.key, file.bytes]));
  return {
    files,
    releaseDecision: parseCanonicalOrFormattedJson(
      bytes.candidateReleaseDecisionPath,
      "candidate execution evidence/release-decision.json",
    ),
    releaseDecisionBytes: bytes.candidateReleaseDecisionPath,
    releaseEvidenceBundle: parseCanonicalOrFormattedJson(
      bytes.candidateReleaseEvidenceBundlePath,
      "candidate execution evidence/release-evidence-bundle.json",
    ),
    releaseEvidenceBundleBytes: bytes.candidateReleaseEvidenceBundlePath,
  };
}

function assertReleaseCandidateFresh(freshUntil, now) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("clock result must be epoch milliseconds");
  if (Date.parse(freshUntil) <= now) {
    throw new Error("candidate freshUntil must be in the future at FINAL closure");
  }
}

async function inspectArtifact(artifactRoot, fixed, maxTotalDecompressedBytes = fixed.buildContract.value.maxTotalDecompressedBytes) {
  const rootEntries = (await readdir(artifactRoot)).sort(bytewise);
  const signed = canonicalJson(rootEntries) === canonicalJson([...SIGNED_ARTIFACT_ROOT_FILES].sort(bytewise));
  if (!signed && canonicalJson(rootEntries) !== canonicalJson([...KEYLESS_ARTIFACT_ROOT_FILES].sort(bytewise))) {
    throw new Error("artifact file set mismatch");
  }
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
    signature: { algorithm: SIGNATURE_ALGORITHM, value: "AA" },
  });
  let manifestBytes = null;
  let signedManifestRawSha256 = null;
  if (signed) {
    manifestBytes = await readNonEmptyRegular(path.join(artifactRoot, "manifest.json"), "signed manifest");
    const signedManifest = parseCanonicalJson(manifestBytes, "signed manifest");
    validateArtifactComponentManifest(signedManifest);
    if (!Buffer.from(canonicalJson(withoutSignature(signedManifest))).equals(signingInputBytes)) {
      throw new Error("signed manifest does not match signing input");
    }
    if (signedManifest.keyId !== signingKeyId()) throw new Error("signed manifest keyId mismatch");
    if (signedManifest.signature.algorithm !== SIGNATURE_ALGORITHM
      || !verifyRsaSha256Signature(signingPublicKey(), signingInputBytes, signedManifest.signature.value)) {
      throw new Error("signed manifest signature mismatch");
    }
    signedManifestRawSha256 = sha256(manifestBytes);
  }
  const provenance = parseCanonicalJson(provenanceBytes, "provenance");
  const compatibility = parseCanonicalJson(compatibilityBytes, "compatibility");
  validateMetadata({ manifest, provenance, compatibility, fixed });

  const payloadBytesByComponent = Object.fromEntries(
    COMPONENTS.map((component, index) => [component, payloadBytes[index]]),
  );
  const decompressedBudget = evaluateDecompressedBudget(payloadBytesByComponent, maxTotalDecompressedBytes);

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
  const publicationObjects = [
    ["compatibility.json", compatibilityBytes],
    ["manifest.signing-input.json", signingInputBytes],
    ...COMPONENTS.map((component, index) => [
      `payload/${component}.sqlite.zst`,
      payloadBytes[index],
    ]),
    ["provenance.json", provenanceBytes],
    ...(manifestBytes === null ? [] : [["manifest.json", manifestBytes]]),
  ].map(([objectPath, bytes]) => ({
    path: objectPath,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
  })).sort((left, right) => bytewise(left.path, right.path));
  return {
    manifest,
    provenance,
    compatibility,
    signingInputSha256,
    signedManifestRawSha256,
    componentInventorySha256,
    publicationObjects,
    accessibilityPayloadBytes: payloadBytes[COMPONENTS.indexOf("accessibility")],
    topologyPayloadBytes: payloadBytes[COMPONENTS.indexOf("topology")],
    decompressedBudget,
    evidence: canonicalObject({
      schemaVersion: 1,
      artifactKind: "server-route-bundle-artifact-inventory",
      bundleId: manifest.bundleId,
      releaseSequence: manifest.releaseSequence,
      stationSetSha256: manifest.stationSetSha256,
      signingInputSha256,
      signedManifestRawSha256,
      provenanceSha256: sha256(provenanceBytes),
      compatibilitySha256: sha256(compatibilityBytes),
      componentInventorySha256,
      decompressedBudget,
      entries,
    }),
  };
}

async function assertEmbeddedEvidence(input) {
  const temporary = await mkdtemp(path.join(input.outputParent, ".server-route-evidence-inspect-"));
  const sqlitePath = path.join(temporary, "accessibility.sqlite");
  let database;
  try {
    let sqliteBytes;
    try {
      sqliteBytes = zstdDecompressSync(input.accessibilityPayloadBytes);
    } catch {
      throw new Error("embedded accessibility evidence component is not valid Zstd");
    }
    await writeFile(sqlitePath, sqliteBytes, { flag: "wx" });
    database = new DatabaseSync(sqlitePath, { open: true, readOnly: true });
    if (database.prepare("PRAGMA user_version").get().user_version !== 19) {
      throw new Error("embedded accessibility evidence SQLite user_version mismatch");
    }
    if (database.prepare("PRAGMA quick_check").all().some((row) => row.quick_check !== "ok")) {
      throw new Error("embedded accessibility evidence SQLite quick_check failed");
    }
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new Error("embedded accessibility evidence foreign key mismatch");
    }
    assertEmbeddedTable(database, "station_line_accessibility_evidence", [
      { name: "materialization_digest", type: "TEXT", notnull: 1, pk: 1 },
      { name: "canonical_json", type: "TEXT", notnull: 1, pk: 0 },
    ], GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL.station_line_accessibility_evidence);
    assertEmbeddedTable(database, "route_accessibility_edge_evidence", [
      { name: "evaluation_digest", type: "TEXT", notnull: 1, pk: 1 },
      { name: "materialization_digest", type: "TEXT", notnull: 1, pk: 0 },
      { name: "canonical_json", type: "TEXT", notnull: 1, pk: 0 },
    ], GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL.route_accessibility_edge_evidence);
    assertEmbeddedTable(database, "station_elevator_path", [
      { name: "path_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "station_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "line_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "next_station_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "exit_no", type: "TEXT", notnull: 1, pk: 0 },
      { name: "platform_direction", type: "TEXT", notnull: 1, pk: 0 },
      { name: "step", type: "INTEGER", notnull: 1, pk: 2 },
      { name: "detail", type: "TEXT", notnull: 1, pk: 0 },
    ], GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL.station_elevator_path);
    assertEmbeddedTable(database, "station_elevator_path_facility", [
      { name: "path_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "group_kind", type: "TEXT", notnull: 1, pk: 2 },
      { name: "facility_id", type: "TEXT", notnull: 1, pk: 3 },
    ], GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL.station_elevator_path_facility);
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='facilities'").get()) {
      throw new Error("facilities table is missing");
    }
    const orphanPaths = database.prepare(
      "SELECT DISTINCT path_id FROM station_elevator_path_facility WHERE path_id NOT IN (SELECT path_id FROM station_elevator_path) ORDER BY path_id",
    ).all();
    if (orphanPaths.length > 0) {
      throw new Error(`station_elevator_path_facility contains orphan path_id: ${orphanPaths.map((row) => row.path_id).join(", ")}`);
    }
    const hasFacilitiesTable = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='facilities'").get());
    const orphanFacilities = database.prepare(hasFacilitiesTable
      ? "SELECT DISTINCT facility_id FROM station_elevator_path_facility WHERE facility_id NOT IN (SELECT id FROM facilities) ORDER BY facility_id"
      : "SELECT DISTINCT facility_id FROM station_elevator_path_facility ORDER BY facility_id").all();
    if (orphanFacilities.length > 0) {
      throw new Error(`station_elevator_path_facility contains orphan facility_id: ${orphanFacilities.map((row) => row.facility_id).join(", ")}`);
    }
    // #827: 무단차 요구 행은 번들 경로·시설 묶음과 route edge의 승강장 노드(#873)로 다시 만든 결과와 정확히 같아야 한다.
    assertEmbeddedTable(database, "transition_facility_requirement", [
      { name: "transition_key", type: "TEXT", notnull: 1, pk: 1 },
      { name: "path_id", type: "TEXT", notnull: 1, pk: 2 },
      { name: "direction_next_station_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "group_kind", type: "TEXT", notnull: 1, pk: 3 },
      { name: "facility_id", type: "TEXT", notnull: 1, pk: 4 },
    ], GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL.transition_facility_requirement);
    const requirements = sortTransitionFacilityRequirements(database.prepare(
      "SELECT transition_key, path_id, direction_next_station_id, group_kind, facility_id FROM transition_facility_requirement",
    ).all());
    if (requirements.length === 0) throw new Error("transition_facility_requirement is empty");
    const stepFreeInputs = readBundledStepFreeInputs(database);
    validateTransitionFacilityRequirements({ ...stepFreeInputs, requirements, routeEdges: input.routeEdges });
    if (canonicalJson(buildTransitionFacilityRequirements({ ...stepFreeInputs, routeEdges: input.routeEdges })) !== canonicalJson(requirements)) {
      throw new Error("transition_facility_requirement does not match station elevator path derivation");
    }
    // #837: 승강장 연단 간격 등급 행은 번들 station_lines에 속한 역·노선에만 있어야 한다.
    assertEmbeddedTable(database, "station_platform_gaps", [
      { name: "id", type: "TEXT", notnull: 0, pk: 1 },
      { name: "station_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "line_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "direction", type: "TEXT", notnull: 0, pk: 0 },
      { name: "platform_position", type: "TEXT", notnull: 1, pk: 0 },
      { name: "car_number", type: "INTEGER", notnull: 0, pk: 0 },
      { name: "door_number", type: "INTEGER", notnull: 0, pk: 0 },
      { name: "gap_grade", type: "TEXT", notnull: 1, pk: 0 },
      { name: "height_diff_grade", type: "TEXT", notnull: 1, pk: 0 },
      { name: "curved", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "source_snapshot_id", type: "TEXT", notnull: 1, pk: 0 },
    ], GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL.station_platform_gaps);
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='station_lines'").get()) {
      const orphanPlatformGaps = database.prepare(
        "SELECT DISTINCT station_id, line_id FROM station_platform_gaps WHERE (station_id, line_id) NOT IN (SELECT station_id, line_id FROM station_lines) ORDER BY station_id, line_id",
      ).all();
      if (orphanPlatformGaps.length > 0) {
        throw new Error(`station_platform_gaps contains orphan station-line: ${orphanPlatformGaps.map((row) => `${row.station_id}/${row.line_id}`).join(", ")}`);
      }
    }
    // #925: 환승 계단 근거 행은 route-edge 입력의 역 안 환승 간선만 가리킨다(emit 단계가 topology STEP_FREE 집합과 같음을 검사한다).
    assertEmbeddedTable(database, "transfer_stair_access_evidence", [
      { name: "edge_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "from_direction_station_id", type: "TEXT", notnull: 1, pk: 2 },
      { name: "to_direction_station_id", type: "TEXT", notnull: 1, pk: 3 },
      { name: "path_sha256", type: "TEXT", notnull: 1, pk: 4 },
      { name: "source_snapshot_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "duration_basis", type: "TEXT", notnull: 1, pk: 0 },
    ], GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL.transfer_stair_access_evidence);
    const foreignSnapshotIds = database.prepare("SELECT DISTINCT source_snapshot_id FROM transfer_stair_access_evidence WHERE source_snapshot_id <> ? ORDER BY source_snapshot_id")
      .all(input.transferStairSnapshotId).map((row) => row.source_snapshot_id);
    if (foreignSnapshotIds.length > 0) {
      throw new Error(`transfer_stair_access_evidence source_snapshot_id does not match the admitted MOLIT snapshot: ${foreignSnapshotIds.join(", ")}`);
    }
    const inStationTransferEdgeIds = new Set(input.routeEdges
      .filter(({ edgeType }) => edgeType === "IN_STATION_TRANSFER").map(({ edgeId }) => edgeId));
    const evidenceEdgeIds = database.prepare("SELECT DISTINCT edge_id FROM transfer_stair_access_evidence ORDER BY edge_id").all()
      .map((row) => row.edge_id);
    const orphanTransferStairEdges = evidenceEdgeIds.filter((edgeId) => !inStationTransferEdgeIds.has(edgeId));
    if (orphanTransferStairEdges.length > 0) {
      throw new Error(`transfer_stair_access_evidence contains edge_id outside in-station transfer route edges: ${orphanTransferStairEdges.join(", ")}`);
    }
    // #944 F4: topology의 STEP_FREE 역 안 환승 간선 집합은 근거 간선 집합과 정확히 같고, STEP_FREE 간선에는 계단이 없다.
    const topology = await readEmbeddedTopologyStairEdges(input.topologyPayloadBytes, temporary);
    const stairedStepFree = topology.filter(({ stairAccessState, includesStairs }) => stairAccessState === "STEP_FREE" && includesStairs !== 0)
      .map(({ id }) => id);
    if (stairedStepFree.length > 0) throw new Error(`network_edges STEP_FREE edge includes stairs: ${stairedStepFree.join(", ")}`);
    const stepFreeTransfers = topology.filter(({ edgeType, stairAccessState }) => edgeType === "IN_STATION_TRANSFER" && stairAccessState === "STEP_FREE")
      .map(({ id }) => id).sort(bytewise);
    if (canonicalJson(stepFreeTransfers) !== canonicalJson([...evidenceEdgeIds].sort(bytewise))) {
      throw new Error("transfer_stair_access_evidence does not match network_edges STEP_FREE in-station transfers");
    }
    const stationRows = database.prepare("SELECT materialization_digest, canonical_json FROM station_line_accessibility_evidence").all();
    if (stationRows.length !== 1
      || stationRows[0].materialization_digest !== input.materialization.materializationDigest
      || stationRows[0].canonical_json !== input.materializationBytes.toString("utf8")) {
      throw new Error("embedded station-line accessibility evidence mismatch");
    }
    const routeRows = database.prepare("SELECT evaluation_digest, materialization_digest, canonical_json FROM route_accessibility_edge_evidence").all();
    if (routeRows.length !== 1
      || routeRows[0].evaluation_digest !== input.evaluation.evaluationDigest
      || routeRows[0].materialization_digest !== input.materialization.materializationDigest
      || routeRows[0].canonical_json !== input.evaluationBytes.toString("utf8")) {
      throw new Error("embedded route-edge evaluation evidence mismatch");
    }
  } finally {
    database?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

// #944 F4: topology component에서 network_edges 계단 칸만 읽는다. 표가 없으면 실패한다.
async function readEmbeddedTopologyStairEdges(topologyPayloadBytes, temporary) {
  let sqliteBytes;
  try {
    sqliteBytes = zstdDecompressSync(topologyPayloadBytes);
  } catch {
    throw new Error("embedded topology component is not valid Zstd");
  }
  const sqlitePath = path.join(temporary, "topology.sqlite");
  await writeFile(sqlitePath, sqliteBytes, { flag: "wx" });
  const database = new DatabaseSync(sqlitePath, { open: true, readOnly: true });
  try {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='network_edges'").get()) {
      throw new Error("embedded topology network_edges is missing");
    }
    return database.prepare("SELECT id, edge_type AS edgeType, includes_stairs AS includesStairs, stair_access_state AS stairAccessState FROM network_edges ORDER BY id")
      .all().map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

// #925: 환승 계단 근거의 기준 원천은 source inventory가 잠근 MOLIT 환승 이동경로 스냅샷이다.
function admittedTransferStairSnapshotId(sourceInventory) {
  const matches = (sourceInventory?.sources ?? []).filter(({ id }) => id === "molit-railway-transfer-movement");
  const admission = matches[0]?.rawSnapshotAdmission;
  if (matches.length !== 1 || admission?.status !== "LOCKED" || typeof admission.snapshotId !== "string" || admission.snapshotId === "") {
    throw new Error("source inventory MOLIT transfer snapshot admission is missing");
  }
  return admission.snapshotId;
}

function assertEmbeddedTable(database, table, expected, expectedDdl) {
  const actual = database.prepare(`PRAGMA table_xinfo(${table})`).all().map((column) => ({
    name: column.name,
    type: column.type,
    notnull: column.notnull,
    pk: column.pk,
  }));
  const definition = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (canonicalJson(actual) !== canonicalJson(expected) || definition?.sql !== expectedDdl) {
    throw new Error(`embedded ${table} schema mismatch`);
  }
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
  const buildSpecPublishedAtMillis = typeof buildSpec.publishedAt === "string" ? Date.parse(buildSpec.publishedAt) : Number.NaN;
  const evaluationAtMillis = Date.parse(evaluationAt);
  const freshnessEvaluationAt = Number.isFinite(buildSpecPublishedAtMillis) && buildSpecPublishedAtMillis > evaluationAtMillis
    ? buildSpec.publishedAt
    : evaluationAt;
  try {
    validation = validateSourceSnapshotFreshness({
      buildSpec,
      snapshots: fixed.sourceSnapshots.value,
      policy: fixed.freshnessPolicy.value,
      evaluationAt: freshnessEvaluationAt,
      governancePolicy: fixed.governancePolicy.value,
      inventory: fixed.sourceInventory.value,
      governancePolicySha256: fixed.governancePolicy.sha256,
      governancePolicyBytes: fixed.governancePolicy.bytes,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "SOURCE_SNAPSHOT_EXPIRED") throw error;
    state = "STALE";
    reason = error.message;
  }
  if (Date.parse(artifact.manifest.freshUntil) <= Date.parse(freshnessEvaluationAt)) {
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
      evaluationAt: freshnessEvaluationAt,
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

function validateStationLineInput(value, artifact, candidateId) {
  assertKeys(value, ["candidate", "stationLines", "evidenceRows"], "station-line input keys");
  if (!Array.isArray(value.stationLines) || !Array.isArray(value.evidenceRows)) {
    throw new Error("station-line arrays are required");
  }
  assertCandidateBinding(value.candidate, artifact, false, candidateId);
  if (value.candidate.stationSetSha256 !== scopedStationSetSha256(value.stationLines)) {
    throw new Error("station-line scoped station set identity mismatch");
  }
  return value;
}

function validateRouteEdgeInput(value, artifact, candidateId, stationSetSha256) {
  assertKeys(value, ["candidate", "stationLines", "routeEdges"], "route-edge input keys");
  if (!Array.isArray(value.stationLines) || !Array.isArray(value.routeEdges)) {
    throw new Error("route-edge arrays are required");
  }
  assertCandidateBinding(value.candidate, artifact, false, candidateId);
  if (value.candidate.stationSetSha256 !== stationSetSha256) {
    throw new Error("route-edge station-line candidate station set identity mismatch");
  }
  const rides = value.routeEdges.filter(({ edgeType }) => edgeType === "RIDE");
  const seedTopologySha256 = canonicalRideEdgeSetSha256(rides);
  if (value.candidate.topologySha256 !== artifact.manifest.topologySha256
    && value.candidate.topologySha256 !== seedTopologySha256) {
    throw new Error("topology identity mismatch");
  }
  const evaluationCandidate = {
    ...value.candidate,
    stationSetSha256: artifact.manifest.stationSetSha256,
    topologySha256: artifact.manifest.topologySha256,
  };
  assertCandidateBinding(evaluationCandidate, artifact, true, candidateId);
  return { ...value, candidate: evaluationCandidate };
}

function assertCandidateBinding(candidate, artifact, requireTopology, expectedCandidateId) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("candidate identity is required");
  }
  if (candidate.candidateId !== expectedCandidateId) throw new Error("candidate identity mismatch");
  if (requireTopology && candidate.stationSetSha256 !== artifact.manifest.stationSetSha256) throw new Error("station set identity mismatch");
  if (candidate.sourceSetSha256 !== artifact.provenance.sourceSnapshotSetHash) throw new Error("source set identity mismatch");
  if (requireTopology && candidate.topologySha256 !== artifact.manifest.topologySha256) {
    throw new Error("topology identity mismatch");
  }
}

function scopedStationSetSha256(stationLines) {
  const stationIds = stationLines.map((line) => line?.stationId);
  if (stationIds.some((stationId) => typeof stationId !== "string" || stationId === "")) {
    throw new Error("station-line scoped station set identity mismatch");
  }
  return sha256(Buffer.from(canonicalJson([...new Set(stationIds)].sort(bytewise))));
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

async function routeAccessibilityEligibilityGate({ reportPath, candidate, materialization, materializationBytes, evaluation, evaluationBytes }) {
  if (reportPath === undefined) {
    return { gate: { state: "UNAVAILABLE", evidenceSha256: null }, file: null };
  }
  const target = path.resolve(requiredRaw(reportPath, "eligibility report"));
  const bytes = await readNonEmptyRegular(target, "eligibility report");
  const report = parseCanonicalJson(bytes, "eligibility report");
  assertKeys(report, [
    "schemaVersion", "artifactKind", "decision", "candidate", "stationLineAccessibility", "routeEdgeEvaluation", "blockers", "eligibilitySha256",
  ], "eligibility report keys");
  assertKeys(report.stationLineAccessibility, [
    "rowCount", "stateSummary", "materializationDigest", "evidenceSha256",
  ], "eligibility station-line keys");
  assertKeys(report.routeEdgeEvaluation, [
    "edgeCount", "stateSummary", "evaluationDigest", "evidenceSha256",
  ], "eligibility route-edge keys");
  const payload = { ...report };
  delete payload.eligibilitySha256;
  if (report.schemaVersion !== 1 || report.artifactKind !== "route-accessibility-eligibility"
    || !["ELIGIBLE", "INELIGIBLE"].includes(report.decision)
    || report.eligibilitySha256 !== sha256(Buffer.from(canonicalJson(payload)))) {
    throw new Error("eligibility report identity mismatch");
  }
  if (!Array.isArray(report.blockers) || report.blockers.some((blocker) => typeof blocker !== "string" || blocker.length === 0)
    || canonicalJson(report.blockers) !== canonicalJson([...new Set(report.blockers)].sort(bytewise))) {
    throw new Error("eligibility report blockers mismatch");
  }
  const evidenceSha256 = sha256(bytes);
  const matches = canonicalJson(report.candidate) === canonicalJson(candidate)
    && report.stationLineAccessibility.rowCount === materialization.rows.length
    && canonicalJson(report.stationLineAccessibility.stateSummary) === canonicalJson(materialization.stateSummary)
    && report.stationLineAccessibility?.materializationDigest === materialization.materializationDigest
    && report.stationLineAccessibility?.evidenceSha256 === sha256(materializationBytes)
    && report.routeEdgeEvaluation.edgeCount === evaluation.results.length
    && canonicalJson(report.routeEdgeEvaluation.stateSummary) === canonicalJson(evaluation.stateSummary)
    && report.routeEdgeEvaluation?.evaluationDigest === evaluation.evaluationDigest
    && report.routeEdgeEvaluation?.evidenceSha256 === sha256(evaluationBytes)
    && (report.decision === "ELIGIBLE" ? report.blockers.length === 0 : report.blockers.length > 0);
  const file = { key: "eligibilityReportPath", target, bytes };
  if (!matches) {
    return { gate: { state: "IDENTITY_MISMATCH", evidenceSha256 }, file };
  }
  return {
    gate: {
      state: report.decision === "ELIGIBLE" ? "PASS" : "INELIGIBLE",
      evidenceSha256,
    },
    file,
  };
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
  const cliArguments = Object.fromEntries(args);
  const suppliedKeys = Object.keys(cliArguments).sort(bytewise);
  const baseKeys = [...BASE_CLI_KEYS].sort(bytewise);
  const boundKeys = [...BASE_CLI_KEYS, ELIGIBILITY_CLI_KEY].sort(bytewise);
  const releaseKeys = [...boundKeys, ...RELEASE_CLI_KEYS].sort(bytewise);
  const baseMode = canonicalJson(suppliedKeys) === canonicalJson(baseKeys);
  const boundMode = canonicalJson(suppliedKeys) === canonicalJson(boundKeys);
  const releaseMode = canonicalJson(suppliedKeys) === canonicalJson(releaseKeys);
  if (!baseMode && !boundMode && !releaseMode) throw new Error("CLI arguments mismatch");
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
    ...(boundMode || releaseMode ? { eligibilityReportPath: requiredArg(args, ELIGIBILITY_CLI_KEY) } : {}),
    ...(releaseMode ? {
      releaseEvidence: {
        approvalEvidencePath: requiredArg(args, "approval-evidence"),
        compatibilityEvidencePath: requiredArg(args, "compatibility-evidence"),
        promotionComponentPath: requiredArg(args, "promotion-component"),
        promotionInventoryPath: requiredArg(args, "promotion-inventory"),
        promotionRequestPath: requiredArg(args, "promotion-request"),
        promotionWorkflowRunId: requiredArg(args, "promotion-workflow-run-id"),
        publicationReceiptPath: requiredArg(args, "publication-receipt"),
        candidateExecutionEvidenceRoot: requiredArg(args, "candidate-execution-evidence-root"),
      },
    } : {}),
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
