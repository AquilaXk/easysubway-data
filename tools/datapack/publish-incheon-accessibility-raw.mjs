#!/usr/bin/env node
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../lib/is-main-module.mjs";
import {
  validateIncheonAccessibilityRawCollection,
  validateIncheonAccessibilitySnapshotIdentity,
} from "./collect-incheon-accessibility.mjs";
import {
  parseAccessibilityRawPublisherArgs,
  publishAccessibilityRawObservation,
} from "./lib/kric-raw-object-storage.mjs";

const SOURCE_ID = "incheon-transit-accessibility";
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export async function publishIncheonAccessibilityRawArtifact({
  observationRoot,
  receiptPath,
  repositoryRoot = ROOT,
  env = process.env,
  client = null,
  now = new Date(),
} = {}) {
  const names = await readdir(observationRoot);
  const expected = ["observation.json"];
  const manifest = JSON.parse(await readFile(path.join(observationRoot, "observation.json"), "utf8"));
  expected.push(manifest.snapshotFile, manifest.rawArtifactFile);
  if (JSON.stringify(names.sort((left, right) => left.localeCompare(right, "en"))) !== JSON.stringify(expected.sort((left, right) => left.localeCompare(right, "en")))) {
    throw new Error("Incheon accessibility observation inventory is invalid");
  }
  return publishAccessibilityRawObservation({
    observationRoot, receiptPath, repositoryRoot, env, client, now,
    sourceId: SOURCE_ID,
    observationArtifactKind: "incheon-accessibility-observation",
    rawArtifactKind: "incheon-accessibility-raw-collection",
    receiptArtifactKind: "incheon-accessibility-raw-object-receipt",
    errorPrefix: "Incheon accessibility raw object",
    validateSnapshotIdentity: validateIncheonAccessibilitySnapshotIdentity,
    validateRawCollection: validateIncheonAccessibilityRawCollection,
  });
}

async function main() {
  const args = parseAccessibilityRawPublisherArgs(process.argv.slice(2));
  if (Object.keys(args).length !== 2 || typeof args.observation !== "string" || typeof args.receipt !== "string") throw new Error("invalid arguments");
  process.stdout.write(`${JSON.stringify(await publishIncheonAccessibilityRawArtifact({ observationRoot: args.observation, receiptPath: args.receipt }), null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : "Incheon accessibility raw publication failed"); process.exitCode = 1; });
}
