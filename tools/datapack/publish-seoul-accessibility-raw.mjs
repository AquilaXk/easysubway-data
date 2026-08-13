#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFileCallback);
const SOURCE_ID = "seoul-metro-accessibility";
const RAW_ARTIFACT_KIND = "seoul-accessibility-raw-collection";
const OBSERVATION_ARTIFACT_KIND = "seoul-accessibility-observation";
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export async function publishSeoulAccessibilityRawArtifact({
  observationRoot,
  receiptPath,
  expectedBucketOwner,
  repositoryRoot = REPOSITORY_ROOT,
  execFileImpl = execFileAsync,
} = {}) {
  return publishAccessibilityRawObservation({
    observationRoot,
    receiptPath,
    expectedBucketOwner,
    repositoryRoot,
    execFileImpl,
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
  const receipt = await publishSeoulAccessibilityRawArtifact({
    observationRoot: args.observation,
    receiptPath: args.receipt,
    expectedBucketOwner: args["expected-bucket-owner"],
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
