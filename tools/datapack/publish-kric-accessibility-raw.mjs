#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../lib/is-main-module.mjs";
import {
  validateKricAccessibilityRawCollection,
  validateKricAccessibilitySnapshotIdentity,
} from "./collect-kric-accessibility-snapshots.mjs";
import {
  parseAccessibilityRawPublisherArgs,
  publishAccessibilityRawObservation,
} from "./lib/kric-raw-object-storage.mjs";

const execFileAsync = promisify(execFileCallback);
const SOURCE_ID = "kric-station-convenience-standard";
const ARTIFACT_KIND = "kric-accessibility-raw-collection";
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export async function publishKricAccessibilityRawArtifact({
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
  const receipt = await publishKricAccessibilityRawArtifact({
    observationRoot: args.observation,
    receiptPath: args.receipt,
    expectedBucketOwner: args["expected-bucket-owner"],
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "KRIC accessibility raw publication failed");
    process.exitCode = 1;
  });
}
