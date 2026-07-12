#!/usr/bin/env node
// admin review record 생성기 — source-admission-runbook.json requiredAdminReviewFields를
// 채운 admin review record를 만든다. run-source-admission-pipeline.mjs의
// validateAdminReview 계약과 100% 일치한다.
//
// 위조 방지:
//   - hash 6종(licenseEvidenceHash·aliasLedgerHash·operatorMappingLedgerHash·
//     facilityEvidenceLedgerHash·routeEvidenceLedgerHash·overrideHash)은
//     export-ledger-hashes.mjs가 낸 JSON 산출물 파일에서만 읽는다.
//     인자로 직접 hex를 받지 않는다 → 손으로 hash를 끼워넣을 수 없다.
//   - sampleEvidenceHash는 sample evidence 파일의 evidenceHash에서 읽는다.
//   - approvedBy·approvedAt·decision은 입력 인자(승인 결정 기록).
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseArgs,
  readJsonFile,
  requireArg,
  requiredString,
  sortJson,
} from "./lib/ledger-admission-cli.mjs";
import { validateQuotaEvidence } from "./lib/quota-evidence.mjs";

const root = path.resolve(import.meta.dirname, "../..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const record = await buildAdminReviewRecord(args);
  console.log(JSON.stringify(record, null, 2));
}

async function buildAdminReviewRecord(args) {
  const candidateId = requireArg(args, "candidate");
  const sourceId = requireArg(args, "source-id");
  const snapshotId = requireArg(args, "snapshot-id");
  const decision = requireArg(args, "decision");
  if (decision !== "APPROVED") {
    throw new Error("--decision must be APPROVED (거부/보류는 admission 대상이 아니다)");
  }

  const sampleEvidenceHash = await readSampleEvidenceHash(args);

  const licenseEvidenceHash = await readLedgerHash(args, "license-hash", "license");
  const aliasLedgerHash = await readLedgerHash(args, "alias-hash", "alias");
  const operatorMappingLedgerHash = await readLedgerHash(args, "operator-mapping-hash", "operator-mapping");
  const facilityEvidenceLedgerHash = await readLedgerHash(args, "facility-evidence-hash", "facility-evidence");
  const routeEvidenceLedgerHash = await readLedgerHash(args, "route-evidence-hash", "route-evidence");
  const overrideHash = await readLedgerHash(args, "override-hash", "override");

  const quotaEvidence = await readQuotaEvidence(args);
  const productionSource = await readProductionSource(args, sourceId, quotaEvidence, sampleEvidenceHash);

  return {
    schemaVersion: 1,
    artifactKind: "source-admission-admin-review",
    candidateId,
    sourceId,
    snapshotId,
    sampleEvidenceHash,
    decision,
    approvedBy: requireArg(args, "approved-by"),
    approvedAt: requireArg(args, "approved-at"),
    licenseEvidenceHash,
    aliasLedgerHash,
    operatorMappingLedgerHash,
    facilityEvidenceLedgerHash,
    routeEvidenceLedgerHash,
    overrideHash,
    quotaEvidence,
    productionSource,
  };
}

// exporter JSON 산출물 파일에서 ledgerHash만 읽는다. kind가 일치하지 않으면 거부.
async function readLedgerHash(args, argName, expectedKind) {
  const filePath = path.resolve(root, requireArg(args, argName));
  const parsed = await readJsonFile(filePath);
  if (parsed.kind !== expectedKind) {
    throw new Error(`--${argName} kind must be ${expectedKind}, got ${parsed.kind}`);
  }
  return assertSha256(parsed.ledgerHash, `--${argName}.ledgerHash`);
}

async function readSampleEvidenceHash(args) {
  const filePath = path.resolve(root, requireArg(args, "sample-evidence"));
  const parsed = await readJsonFile(filePath);
  return assertSha256(parsed.evidenceHash, "sample-evidence.evidenceHash");
}

async function readQuotaEvidence(args) {
  const filePath = path.resolve(root, requireArg(args, "quota-evidence"));
  const parsed = await readJsonFile(filePath);
  validateQuotaEvidence(parsed, "quota-evidence");
  return parsed;
}

async function readProductionSource(args, sourceId, quotaEvidence, sampleEvidenceHash) {
  const filePath = path.resolve(root, requireArg(args, "production-source"));
  const productionSource = await readJsonFile(filePath);
  if (!productionSource || typeof productionSource !== "object" || Array.isArray(productionSource)) {
    throw new TypeError("production-source must be an object");
  }
  if (productionSource.id !== sourceId) {
    throw new Error("production-source.id must match --source-id");
  }
  // admissionEvidence.quotaEvidence가 있으면 admin review quotaEvidence와 일치해야 한다
  // (pipeline validateAdminReview 계약). 미리 검증해 실행 전에 실패시킨다.
  const admissionEvidence = productionSource.admissionEvidence;
  if (admissionEvidence != null) {
    if (typeof admissionEvidence !== "object" || Array.isArray(admissionEvidence)) {
      throw new TypeError("production-source.admissionEvidence must be an object");
    }
    validateQuotaEvidence(admissionEvidence.quotaEvidence, "production-source.admissionEvidence.quotaEvidence");
    if (JSON.stringify(sortJson(admissionEvidence.quotaEvidence)) !== JSON.stringify(sortJson(quotaEvidence))) {
      throw new Error("production-source.admissionEvidence.quotaEvidence must match --quota-evidence");
    }
  }
  return productionSource;
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a sha256 hex string`);
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

export { buildAdminReviewRecord };
