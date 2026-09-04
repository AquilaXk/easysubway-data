import { createHash } from "node:crypto";

import {
  buildCurrentExitReboundAdmissionOciReceipt,
  canonicalCurrentExitReboundAdmissionOciReceiptJson,
} from "../build-current-exit-admission-oci-receipt.mjs";
import { canonicalExitPathAdmissionJson } from "../build-exit-path-admission.mjs";
import { canonicalJson } from "../lib/manifest-validation.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function identity(bytes, prefix) {
  const digest = sha256(bytes);
  return { sha256: digest, headSha: digest.slice(0, 40), operationId: `${prefix}-${digest.slice(0, 16)}` };
}

export function buildFixtureCurrentExitV2Receipt({
  providerCollectionBundleBytes,
  providerCapturedAt,
  normalizedBytes,
  admissionBytes,
  candidateBytes,
} = {}) {
  if (![providerCollectionBundleBytes, normalizedBytes, admissionBytes, candidateBytes]
    .every((value) => Buffer.isBuffer(value))
    || typeof providerCapturedAt !== "string" || Number.isNaN(Date.parse(providerCapturedAt))) {
    throw new Error("fixture EXIT v2 receipt inputs are invalid");
  }
  const source = identity(providerCollectionBundleBytes, "fixture-source");
  const candidate = identity(candidateBytes, "fixture-candidate");
  const candidateHeadSha = candidate.headSha === source.headSha
    ? sha256(Buffer.concat([candidateBytes, Buffer.from("candidate")])).slice(0, 40)
    : candidate.headSha;
  const providerObjectUri = `oci://axvym6vk8g7i/easysubway-datapacks/operations/current-capital-live-chain/v1/heads/${source.headSha}/operations/${source.operationId}/provider-collections/${providerCapturedAt.slice(0, 10).replaceAll("-", "")}-${source.sha256}.json`;
  return buildCurrentExitReboundAdmissionOciReceipt({
    repository: "AquilaXk/easysubway-data",
    sourceMainSha: source.headSha,
    sourceOperationId: source.operationId,
    candidateHeadSha,
    candidateOperationId: candidate.operationId,
    providerCapturedAt,
    providerCollectionBundleBytes,
    providerObjectUri,
    providerObjectSha256: source.sha256,
    providerObjectByteSize: providerCollectionBundleBytes.length,
    sourceReceiptSha256: sha256(Buffer.concat([providerCollectionBundleBytes, Buffer.from("source-receipt")])),
    candidateReceiptSha256: sha256(Buffer.concat([candidateBytes, Buffer.from("candidate-receipt")])),
    reboundCollectionBundleBytes: Buffer.concat([providerCollectionBundleBytes, candidateBytes]),
    normalizedBytes,
    admissionBytes,
  });
}

export function rebindFixtureCurrentExitV2Admission({ admissionBytes, normalizedBytes, providerCollectionBundleBytes, providerCapturedAt, candidateBytes, candidateId, sourceSetSha256 } = {}) {
  if (!Buffer.isBuffer(admissionBytes) || !Buffer.isBuffer(normalizedBytes) || typeof candidateId !== "string"
    || !/^[a-f0-9]{64}$/u.test(sourceSetSha256 ?? "")) throw new Error("fixture EXIT v2 rebind inputs are invalid");
  const admission = JSON.parse(admissionBytes.toString("utf8"));
  const rebound = structuredClone(admission);
  const rows = [rebound.candidate, ...(rebound.cells ?? []), ...(rebound.materializerEvidenceRows ?? [])];
  if (rows.some((row) => !row || typeof row !== "object" || !Object.hasOwn(row, "candidateId") || !Object.hasOwn(row, "sourceSetSha256"))) {
    throw new Error("fixture EXIT v2 rebind candidate identity is invalid");
  }
  for (const row of rows) { row.candidateId = candidateId; row.sourceSetSha256 = sourceSetSha256; }
  const unsigned = structuredClone(rebound);
  delete unsigned.admissionDigest;
  rebound.admissionDigest = sha256(Buffer.from(canonicalJson(unsigned)));
  const reboundAdmissionBytes = Buffer.from(canonicalExitPathAdmissionJson(rebound));
  const receipt = buildFixtureCurrentExitV2Receipt({ providerCollectionBundleBytes, providerCapturedAt, normalizedBytes, admissionBytes: reboundAdmissionBytes, candidateBytes });
  return { admissionBytes: reboundAdmissionBytes, receiptBytes: Buffer.from(`${canonicalCurrentExitReboundAdmissionOciReceiptJson(receipt)}\n`) };
}

export function canonicalFixtureCurrentExitV2ReceiptJson(receipt) {
  return canonicalCurrentExitReboundAdmissionOciReceiptJson(receipt);
}
