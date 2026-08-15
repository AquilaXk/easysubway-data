#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { publishImmutableObjectPlan } from "./publish-object-storage.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { readSeoulTransferObservationDirectory } from "./collect-current-seoul-transfer-distance-duration-snapshot.mjs";

const SOURCE_ID = "seoul-metro-transfer-distance-duration";
const OCI_NAMESPACE = "axvym6vk8g7i";
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SHA256 = /^[0-9a-f]{64}$/u;
const OCI_PAR = new RegExp(`^https://objectstorage\\.[a-z0-9][a-z0-9-]*\\.oraclecloud\\.com/p/[^/?#]+/n/${OCI_NAMESPACE}/b/easysubway-datapacks/o/?$`, "u");
const OCI_BUCKET = "easysubway-datapacks";
const RECEIPT_KEYS = Object.freeze([
  "schemaVersion", "artifactKind", "sourceId", "snapshotId", "snapshotRawSha256", "capturedAt",
  "manifestSha256", "observationSha256", "rawObjectUri", "rawObjectSha256", "ociNamespace", "bucket",
  "objectKey", "capturedDate", "byteSize", "storedAt", "rawRetentionExpiresAt",
]);
const execFile = promisify(execFileCallback);

async function defaultGitRunner(args, { cwd }) {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8" });
  return stdout;
}

export async function assertExactMainPreflight({ repositoryRoot, expectedMainSha, gitRunner = defaultGitRunner } = {}) {
  if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot) || !SHA256.test(expectedMainSha ?? "")) {
    throw new Error("exact-main preflight arguments are invalid");
  }
  const root = path.resolve(repositoryRoot);
  const run = async (args) => String(await gitRunner(args, { cwd: root })).trim();
  const [head, originMain, dirty] = await Promise.all([
    run(["rev-parse", "HEAD"]), run(["rev-parse", "origin/main"]), run(["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (head !== expectedMainSha || originMain !== expectedMainSha || dirty !== "") {
    throw new Error("exact-main preflight failed");
  }
  return { head, originMain };
}

export async function publishSeoulTransferRawArtifact({ observationDirectory, receiptPath, repositoryRoot = ROOT, expectedMainSha, gitRunner, env = process.env, client = null, now = new Date() } = {}) {
  requireAbsolute(observationDirectory, "observationDirectory");
  requireAbsolute(receiptPath, "receiptPath");
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("publication time must be a valid Date");
  if (!OCI_PAR.test(env?.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL?.trim() ?? "")) throw new Error("EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL must be an OCI HTTPS preauthenticated object URL");
  await assertExactMainPreflight({ repositoryRoot, expectedMainSha, gitRunner });
  const observation = await readObservation(observationDirectory);
  if (now < new Date(observation.manifest.capturedAt)) throw new Error("publication time precedes snapshot capture");
  const rawObjectSha256 = sha(observation.rawBytes);
  const date = observation.manifest.capturedAt.slice(0, 10).replaceAll("-", "");
  const objectKey = `source-raw/${SOURCE_ID}/${date}/${rawObjectSha256}.json`;
  try {
    await publishImmutableObjectPlan({ root: path.resolve(observationDirectory), client, plan: { steps: [
      { type: "put-immutable-bundle-object", objectKey, sourcePath: "raw-snapshot.json", sha256: rawObjectSha256, sizeBytes: observation.rawBytes.length },
      { type: "verify-immutable-bundle-object", objectKey, sourcePath: "raw-snapshot.json", sha256: rawObjectSha256, sizeBytes: observation.rawBytes.length },
    ] } });
  } catch (error) {
    const status = /\bHTTP\s+([1-5]\d\d)\b/u.exec(String(error?.message ?? ""))?.[1];
    throw new Error(`Seoul transfer raw object storage publication failed${status ? `: HTTP ${status}` : ""}`);
  }
  const policy = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/source-governance-policy.json"), "utf8"));
  const receipt = {
    schemaVersion: 1, artifactKind: "seoul-transfer-raw-object-receipt", sourceId: SOURCE_ID,
    snapshotId: `${SOURCE_ID}-${observation.manifest.capturedAt.replaceAll(/[-:.]/gu, "").replace("Z", "Z")}`,
    snapshotRawSha256: observation.manifest.rawSha256, capturedAt: observation.manifest.capturedAt,
    manifestSha256: sha(observation.manifestBytes), observationSha256: sha(observation.observationBytes),
    rawObjectUri: `oci://${OCI_NAMESPACE}/${OCI_BUCKET}/${objectKey}`, rawObjectSha256,
    ociNamespace: OCI_NAMESPACE, bucket: OCI_BUCKET, objectKey, capturedDate: date,
    byteSize: observation.rawBytes.length, storedAt: now.toISOString(),
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy, sourceId: SOURCE_ID, retrievedAt: observation.manifest.capturedAt }),
  };
  await mkdir(path.dirname(receiptPath), { recursive: true });
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  try { await writeFile(receiptPath, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error?.code !== "EEXIST" || await readFile(receiptPath, "utf8") !== bytes) throw error; }
  return validateSeoulTransferRawReceipt(receipt);
}

async function readObservation(directory) {
  const observation = await readSeoulTransferObservationDirectory(directory);
  if (observation.manifest?.rowCount !== 145 || observation.observation?.rowCount !== 145
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(observation.manifest.capturedAt)) {
    throw new Error("transfer observation identity mismatch");
  }
  return observation;
}

export function validateSeoulTransferRawReceipt(receipt) {
  if (receipt == null || typeof receipt !== "object" || Array.isArray(receipt)
    || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify([...RECEIPT_KEYS].sort())
    || receipt.schemaVersion !== 1 || receipt.artifactKind !== "seoul-transfer-raw-object-receipt" || receipt.sourceId !== SOURCE_ID
    || typeof receipt.snapshotId !== "string" || !receipt.snapshotId.startsWith(`${SOURCE_ID}-`)
    || !SHA256.test(receipt.snapshotRawSha256 ?? "") || !SHA256.test(receipt.manifestSha256 ?? "")
    || !SHA256.test(receipt.observationSha256 ?? "") || !SHA256.test(receipt.rawObjectSha256 ?? "")
    || receipt.ociNamespace !== OCI_NAMESPACE || receipt.bucket !== OCI_BUCKET || !/^\d{8}$/u.test(receipt.capturedDate ?? "")
    || receipt.objectKey !== `source-raw/${SOURCE_ID}/${receipt.capturedDate}/${receipt.rawObjectSha256}.json`
    || receipt.rawObjectUri !== `oci://${OCI_NAMESPACE}/${OCI_BUCKET}/${receipt.objectKey}`
    || receipt.capturedAt !== `${receipt.capturedDate.slice(0, 4)}-${receipt.capturedDate.slice(4, 6)}-${receipt.capturedDate.slice(6, 8)}${receipt.capturedAt?.slice(10) ?? ""}`
    || !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize <= 0
    || Number.isNaN(Date.parse(receipt.capturedAt)) || Number.isNaN(Date.parse(receipt.storedAt))
    || Number.isNaN(Date.parse(receipt.rawRetentionExpiresAt)) || Date.parse(receipt.storedAt) < Date.parse(receipt.capturedAt)
    || Date.parse(receipt.rawRetentionExpiresAt) <= Date.parse(receipt.storedAt)) {
    throw new Error("transfer OCI receipt mismatch");
  }
  return receipt;
}
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function requireAbsolute(value, label) { if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`); }
function parseArgs(argv) {
  if (argv.length !== 6 || argv[0] !== "--observation-directory" || argv[2] !== "--receipt" || argv[4] !== "--expected-main-sha") {
    throw new Error("arguments must be --observation-directory <absolute> --receipt <absolute> --expected-main-sha <sha256>");
  }
  return { observationDirectory: argv[1], receiptPath: argv[3], expectedMainSha: argv[5] };
}
if (isMainModule(import.meta.url)) {
  publishSeoulTransferRawArtifact(parseArgs(process.argv.slice(2))).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
