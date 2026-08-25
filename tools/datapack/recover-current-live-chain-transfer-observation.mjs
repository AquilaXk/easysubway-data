#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  reconstructSeoulTransferObservationFromRawSnapshot,
  writeReconstructedSeoulTransferObservation,
} from "./collect-current-seoul-transfer-distance-duration-snapshot.mjs";
import {
  preauthenticatedObjectStorageClient,
  requireCurrentCapitalLiveChainOciParBaseUrl,
} from "./publish-object-storage.mjs";
import { validateSeoulTransferRawReceipt } from "./publish-seoul-transfer-raw.mjs";
import { rebindCurrentLiveChainTransferDerivedIdentities } from "./rebind-current-live-chain-transfer-derived-identities.mjs";

const SOURCE_ID = "seoul-metro-transfer-distance-duration";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function recoverCurrentLiveChainTransferObservation({
  repositoryRoot,
  recoveryRoot,
  env = process.env,
  now = new Date(),
  client = null,
  rebind = rebindCurrentLiveChainTransferDerivedIdentities,
  readFileImpl = readFile,
} = {}) {
  const root = requiredAbsolute(repositoryRoot, "repository root");
  const recovery = requiredAbsolute(recoveryRoot, "recovery root");
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("recovery time must be valid");
  const parBaseUrl = requireCurrentCapitalLiveChainOciParBaseUrl(env);
  const [ledgerBytes, candidatesBytes] = await Promise.all([
    readFileImpl(path.join(root, "tools/datapack/release/source-snapshots.json")),
    readFileImpl(path.join(root, "tools/datapack/source-candidates.json")),
  ]);
  const receipt = activeLockedTransferReceipt(JSON.parse(ledgerBytes));
  if (now.valueOf() >= Date.parse(receipt.rawRetentionExpiresAt)) throw new Error("transfer raw retention has expired");
  const storage = client ?? preauthenticatedObjectStorageClient(parBaseUrl, { includeErrorBody: false });
  const fetched = await storage.readObject(receipt.objectKey);
  if (!fetched?.exists || !Buffer.isBuffer(fetched.body) || fetched.body.length !== receipt.byteSize || sha256(fetched.body) !== receipt.rawObjectSha256) {
    throw new Error("transfer OCI full GET bytes mismatch");
  }
  await mkdir(recovery, { mode: 0o700 });
  let preserveRecoveryEvidence = false;
  try {
    const reconstruction = await reconstructSeoulTransferObservationFromRawSnapshot({
      rawBytes: fetched.body,
      receipt,
      candidatesDocument: JSON.parse(candidatesBytes),
    });
    await Promise.all([
      writeFile(path.join(recovery, "raw-snapshot.json"), fetched.body, { flag: "wx", mode: 0o600 }),
      writeFile(path.join(recovery, "receipt.json"), `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 }),
    ]);
    const observationDirectory = path.join(recovery, "observation");
    await writeReconstructedSeoulTransferObservation({ output: observationDirectory, runnerTemp: recovery, reconstruction });
    preserveRecoveryEvidence = true;
    return await rebind({ repositoryRoot: root, observationDirectory, receiptPath: path.join(recovery, "receipt.json") });
  } finally {
    if (!preserveRecoveryEvidence) await rm(recovery, { recursive: true, force: true });
  }
}

export function activeLockedTransferReceipt(ledger) {
  if (!Array.isArray(ledger)) throw new Error("transfer source ledger must be an array");
  const matches = ledger.filter((entry) => entry?.sourceId === SOURCE_ID && entry.snapshotStatus === "LOCKED" && entry.fetchStatus === "SUCCESS");
  if (matches.length !== 1) throw new Error("transfer source ledger must contain one active locked receipt");
  const row = matches[0];
  const receipt = validateSeoulTransferRawReceipt(row.rawReceipt);
  if (row.snapshotId !== receipt.snapshotId || row.rawSha256 !== receipt.snapshotRawSha256 || row.rawSha256 !== receipt.rawObjectSha256
    || row.rowCount !== 145 || row.contentSha256 == null || row.schemaFingerprint == null || row.rawObjectUri !== receipt.rawObjectUri) {
    throw new Error("transfer source ledger receipt identity mismatch");
  }
  return receipt;
}

function requiredAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return path.resolve(value);
}

export function parseRecoveryArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== "--repository-root" || argv[2] !== "--recovery-root") {
    throw new Error("arguments must be --repository-root <absolute> --recovery-root <absolute>");
  }
  return { repositoryRoot: requiredAbsolute(argv[1], "repository root"), recoveryRoot: requiredAbsolute(argv[3], "recovery root") };
}

async function main(argv = process.argv.slice(2)) {
  const result = await recoverCurrentLiveChainTransferObservation(parseRecoveryArgs(argv));
  process.stdout.write(`${JSON.stringify({ result: "PASS", targetCount: result.targets?.length ?? 0 })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write("TRANSFER recovery failed\n"); process.exitCode = 1; });
}
