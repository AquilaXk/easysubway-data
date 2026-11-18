#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../lib/is-main-module.mjs";
import {
  requireKricAccessibilityOperation,
  validateKricAccessibilityRawCollection,
  validateKricAccessibilitySnapshotIdentity,
} from "./collect-kric-accessibility-snapshots.mjs";
import {
  parseAccessibilityRawPublisherArgs,
  publishAccessibilityRawObservation,
} from "./lib/kric-raw-object-storage.mjs";

const ARTIFACT_KIND = "kric-accessibility-raw-collection";
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export async function publishKricAccessibilityRawArtifact({
  sourceId,
  observationRoot,
  receiptPath,
  repositoryRoot = REPOSITORY_ROOT,
  env = process.env,
  client = null,
  now = new Date(),
} = {}) {
  requireKricAccessibilityOperation(sourceId);
  return publishAccessibilityRawObservation({
    observationRoot,
    receiptPath,
    repositoryRoot,
    env,
    client,
    now,
    sourceId,
    observationArtifactKind: "kric-standard-accessibility-observation",
    rawArtifactKind: ARTIFACT_KIND,
    receiptArtifactKind: "kric-accessibility-raw-object-receipt",
    errorPrefix: "KRIC accessibility raw object",
    validateSnapshotIdentity: validateKricAccessibilitySnapshotIdentity,
    validateRawCollection: validateKricAccessibilityRawCollection,
  });
}

async function main() {
  const args = parseAccessibilityRawPublisherArgs(process.argv.slice(2));
  if (Object.keys(args).length !== 3 || typeof args["source-id"] !== "string" || typeof args.observation !== "string" || typeof args.receipt !== "string") {
    throw new Error("invalid arguments");
  }
  const receipt = await publishKricAccessibilityRawArtifact({
    sourceId: args["source-id"],
    observationRoot: args.observation,
    receiptPath: args.receipt,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "KRIC accessibility raw publication failed");
    process.exitCode = 1;
  });
}
