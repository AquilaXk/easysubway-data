#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../lib/is-main-module.mjs";
import {
  validateSeoulAccessibilityRawCollection,
  validateSeoulAccessibilitySnapshotIdentity,
} from "./collect-seoul-accessibility-evidence.mjs";
import {
  parseAccessibilityRawPublisherArgs,
  publishAccessibilityRawObservation,
} from "./lib/kric-raw-object-storage.mjs";

const SOURCE_ID = "seoul-metro-accessibility";
const RAW_ARTIFACT_KIND = "seoul-accessibility-raw-collection";
const OBSERVATION_ARTIFACT_KIND = "seoul-accessibility-observation";
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export async function publishSeoulAccessibilityRawArtifact({
  observationRoot,
  receiptPath,
  repositoryRoot = REPOSITORY_ROOT,
  env = process.env,
  client = null,
  now = new Date(),
} = {}) {
  return publishAccessibilityRawObservation({
    observationRoot,
    receiptPath,
    repositoryRoot,
    env,
    client,
    now,
    sourceId: SOURCE_ID,
    observationArtifactKind: OBSERVATION_ARTIFACT_KIND,
    rawArtifactKind: RAW_ARTIFACT_KIND,
    receiptArtifactKind: "seoul-accessibility-raw-object-receipt",
    errorPrefix: "Seoul accessibility raw object",
    validateSnapshotIdentity: validateSeoulAccessibilitySnapshotIdentity,
    validateRawCollection: validateSeoulAccessibilityRawCollection,
  });
}

async function main() {
  const args = parseAccessibilityRawPublisherArgs(process.argv.slice(2));
  if (Object.keys(args).length !== 2 || typeof args.observation !== "string" || typeof args.receipt !== "string") {
    throw new Error("invalid arguments");
  }
  const receipt = await publishSeoulAccessibilityRawArtifact({
    observationRoot: args.observation,
    receiptPath: args.receipt,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Seoul accessibility raw publication failed");
    process.exitCode = 1;
  }
}
