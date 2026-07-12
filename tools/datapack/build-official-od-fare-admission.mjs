#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildFareStationLineMappingLedger } from "./export-ledger-hashes.mjs";
import { parseArgs, requiredString } from "./lib/ledger-admission-cli.mjs";
import {
  officialOdFareQuoteSetHash,
  validateOfficialOdFareEvidence,
} from "./lib/official-od-fare-evidence.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const REVIEW_KEYS = [
  "approvedAt",
  "approvedBy",
  "artifactKind",
  "decision",
  "evidenceHash",
  "schemaVersion",
  "snapshotId",
  "sourceId",
];

async function main() {
  const admission = await buildOfficialOdFareAdmission(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(admission, null, 2));
}

async function buildOfficialOdFareAdmission(args) {
  assertExactKeys(args, ["admin-review", "evidence"], "argument");
  const evidenceArg = requiredString(args.evidence, "--evidence");
  const reviewArg = requiredString(args["admin-review"], "--admin-review");
  const evidencePath = path.resolve(root, evidenceArg);
  const reviewPath = path.resolve(root, reviewArg);
  const evidenceBytes = await readFile(evidencePath);
  const evidence = JSON.parse(evidenceBytes);
  const review = JSON.parse(await readFile(reviewPath, "utf8"));

  validateOfficialOdFareEvidence(evidence);
  validateReview(review);
  const evidenceHash = sha256(evidenceBytes);
  if (review.evidenceHash !== evidenceHash) {
    throw new Error("admin review evidenceHash must match sanitized evidence");
  }
  const mappingLedger = buildFareStationLineMappingLedger(evidence, review.sourceId);

  return {
    schemaVersion: 1,
    artifactKind: "official-od-fare-admission",
    evidenceHash,
    decision: review.decision,
    approvedBy: review.approvedBy,
    approvedAt: review.approvedAt,
    sourceId: review.sourceId,
    snapshotId: review.snapshotId,
    quoteCount: evidence.quotes.length,
    quoteSetHash: officialOdFareQuoteSetHash(evidence.quotes.map((quote) => ({
      originStationId: quote.originStationId,
      destinationStationId: quote.destinationStationId,
      ...quote.fares,
    }))),
    fareStationLineMappingLedgerHash: mappingLedger.ledgerHash,
  };
}

function validateReview(review) {
  assertObject(review, "admin review");
  assertExactKeys(review, REVIEW_KEYS, "admin review");
  if (review.schemaVersion !== 1) throw new Error("admin review schemaVersion must be 1");
  if (review.artifactKind !== "official-od-fare-admin-review") {
    throw new Error("admin review artifactKind must be official-od-fare-admin-review");
  }
  if (review.decision !== "APPROVED") throw new Error("admin review decision must be APPROVED");
  assertSha256(review.evidenceHash, "admin review evidenceHash");
  requiredString(review.approvedBy, "admin review approvedBy");
  requiredString(review.approvedAt, "admin review approvedAt");
  requiredString(review.sourceId, "admin review sourceId");
  requiredString(review.snapshotId, "admin review snapshotId");
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${key} is not allowed in ${label}`);
  }
  for (const key of allowed) {
    if (!(key in value)) throw new Error(`${label}.${key} is required`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a sha256 hex string`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

export { buildOfficialOdFareAdmission };
