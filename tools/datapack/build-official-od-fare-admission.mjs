#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildFareStationLineMappingLedger } from "./export-ledger-hashes.mjs";
import { parseArgs, requiredString } from "./lib/ledger-admission-cli.mjs";
import {
  officialOdFareAdmissionsBySource,
  officialOdFareQuoteSetHash,
  validateOfficialOdFareEvidence,
} from "./lib/official-od-fare-evidence.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

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
const DIRECTIONS_BY_SOURCE = new Map([
  [
    "seoul-metro-official-od-fares",
    [
      "station-sadang\u0000station-sangnoksu",
      "station-sangnoksu\u0000station-sadang",
    ],
  ],
  [
    "seoul-metro-official-od-fare-canary",
    ["station-2af75c3d707b\u0000station-a2d54a5d63d2"],
  ],
  [
    "busan-transportation-official-od-fares",
    [
      "station-1fc7a7c971c8\u0000station-6b611916f76a",
      "station-fcb7a21e5606\u0000station-6b611916f76a",
      "station-fcb7a21e5606\u0000station-dd45c69d3e40",
    ],
  ],
]);

async function main() {
  const admission = await buildOfficialOdFareAdmission(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(admission, null, 2));
}

async function buildOfficialOdFareAdmission(args) {
  assertAllowedKeys(args, ["admin-review", "bundle", "evidence"], "argument");
  const evidenceArg = requiredString(args.evidence, "--evidence");
  const reviewArg = requiredString(args["admin-review"], "--admin-review");
  const bundleArg = args.bundle === undefined
    ? "tools/datapack/official-od-fare-admission.json"
    : requiredString(args.bundle, "--bundle");
  const evidencePath = path.resolve(root, evidenceArg);
  const reviewPath = path.resolve(root, reviewArg);
  const bundlePath = path.resolve(root, bundleArg);
  const evidenceBytes = await readFile(evidencePath);
  const evidence = JSON.parse(evidenceBytes);
  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));

  validateOfficialOdFareEvidence(evidence);
  validateReview(review);
  const sourceEvidence = evidenceForSource(evidence, review.sourceId);
  officialOdFareAdmissionsBySource(bundle);
  const evidenceHash = sha256(evidenceBytes);
  if (review.evidenceHash !== evidenceHash) {
    throw new Error("admin review evidenceHash must match sanitized evidence");
  }
  const mappingLedger = buildFareStationLineMappingLedger(sourceEvidence, review.sourceId);

  const admission = {
    schemaVersion: 1,
    artifactKind: "official-od-fare-admission",
    evidenceHash,
    decision: review.decision,
    approvedBy: review.approvedBy,
    approvedAt: review.approvedAt,
    sourceId: review.sourceId,
    snapshotId: review.snapshotId,
    quoteCount: sourceEvidence.quotes.length,
    quoteSetHash: officialOdFareQuoteSetHash(sourceEvidence.quotes.map((quote) => ({
      originStationId: quote.originStationId,
      destinationStationId: quote.destinationStationId,
      ...quote.fares,
    }))),
    fareStationLineMappingLedgerHash: mappingLedger.ledgerHash,
  };
  return {
    schemaVersion: 1,
    artifactKind: "official-od-fare-admission-bundle",
    admissions: [
      ...bundle.admissions.filter(({ sourceId }) => sourceId !== admission.sourceId),
      admission,
    ].sort((left, right) => codepointCompare(left.sourceId, right.sourceId)),
  };
}

function evidenceForSource(evidence, sourceId) {
  const expected = DIRECTIONS_BY_SOURCE.get(sourceId);
  if (!expected) {
    throw new Error("evidence directions must match admin review sourceId");
  }
  const quotesByDirection = new Map(evidence.quotes.map((quote) => [
    `${quote.originStationId}\u0000${quote.destinationStationId}`,
    quote,
  ]));
  const quotes = expected.map((direction) => quotesByDirection.get(direction));
  if (quotes.some((quote) => quote === undefined)) {
    throw new Error("evidence directions must match admin review sourceId");
  }
  const stationIds = new Set(quotes.flatMap(({ originStationId, destinationStationId }) => [
    originStationId,
    destinationStationId,
  ]));
  const attemptCounts = Object.fromEntries([
    ...Object.entries(evidence.attemptCounts).filter(([key]) => !key.includes("→")),
    ...expected.map((direction) => {
      const key = direction.replace("\u0000", "→");
      return [key, evidence.attemptCounts[key]];
    }),
  ]);
  const selected = {
    ...evidence,
    attemptCounts,
    providerMappings: evidence.providerMappings.filter(({ stationId }) => stationIds.has(stationId)),
    quotes,
  };
  validateOfficialOdFareEvidence(selected);
  return selected;
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

function assertAllowedKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${key} is not allowed in ${label}`);
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
