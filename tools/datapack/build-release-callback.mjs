#!/usr/bin/env node
// #1694 Part C: 게시 결과에서 release-callback payload를 만들고 HMAC-SHA256 서명한다.
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const CALLBACK_CANONICAL_ORDER = [
  "schemaVersion", "artifactKind", "releaseRequestId", "releaseSequence", "channel",
  "idempotencyKey", "workflowRunUrl", "manifestSha256", "sqliteSha256", "gzipSha256",
  "evidenceBundleSha256", "validatorStatus", "routeRegressionStatus", "publishStatus",
];

export function canonicalCallbackMessage(payload) {
  return CALLBACK_CANONICAL_ORDER.map((key) => String(payload[key])).join("\n");
}

export function buildReleaseCallback(e) {
  const releaseSequence = Number(e.RELEASE_SEQUENCE);
  if (!Number.isSafeInteger(releaseSequence) || releaseSequence < 1) {
    throw new Error("RELEASE_SEQUENCE must be a positive safe integer");
  }
  const required = (name) => {
    const value = e[name];
    if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
    return value;
  };
  const sha256 = (name) => {
    const value = required(name);
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a lowercase SHA-256`);
    return value;
  };
  const channel = required("TARGET_CHANNEL");
  if (!["dev", "staging", "production"].includes(channel)) throw new Error("TARGET_CHANNEL is invalid");
  const gate = (name) => {
    const value = required(name);
    if (!["PASS", "FAIL", "BLOCKED_EXTERNAL"].includes(value)) throw new Error(`${name} is invalid`);
    return value;
  };
  const releaseRequestId = required("RELEASE_REQUEST_ID");
  if (releaseRequestId.includes(":")) {
    throw new Error("RELEASE_REQUEST_ID must not contain ':'");
  }
  const fields = {
    schemaVersion: 2,
    artifactKind: "datapack-release-callback",
    releaseRequestId,
    releaseSequence,
    channel,
    workflowRunUrl: required("WORKFLOW_RUN_URL"),
    manifestSha256: sha256("MANIFEST_SHA256"),
    sqliteSha256: sha256("SQLITE_SHA256"),
    gzipSha256: sha256("GZIP_SHA256"),
    evidenceBundleSha256: sha256("EVIDENCE_BUNDLE_SHA256"),
    validatorStatus: gate("VALIDATOR_STATUS"),
    routeRegressionStatus: gate("ROUTE_REGRESSION_STATUS"),
    publishStatus: gate("PUBLISH_STATUS"),
  };
  fields.idempotencyKey = `${fields.releaseRequestId}:${fields.releaseSequence}:${fields.manifestSha256}`;
  const hmacKey = Buffer.from(required("EASYSUBWAY_DATAPACK_CALLBACK_HMAC_KEY"), "utf8");
  if (hmacKey.length < 32) {
    throw new Error("EASYSUBWAY_DATAPACK_CALLBACK_HMAC_KEY must be at least 32 bytes");
  }
  const value = crypto.createHmac("sha256", hmacKey)
    .update(canonicalCallbackMessage(fields), "utf8").digest("hex");

  return { ...fields, callbackVerifier: { kind: "payload-signature", value } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(JSON.stringify(buildReleaseCallback(process.env)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
