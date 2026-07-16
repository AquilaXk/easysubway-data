#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendReleaseCallback } from "./send-release-callback.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9._-]{1,200}$/;
const RETRY_DELAYS_SECONDS = [60, 480, 3600];

export async function simulateCallbackBackendUnavailable(identity) {
  if (!REQUEST_ID.test(identity?.releaseRequestId ?? "")
    || !Number.isSafeInteger(identity?.releaseSequence) || identity.releaseSequence < 1
    || !SHA256.test(identity?.manifestSha256 ?? "")) {
    throw new Error("callback rehearsal identity is invalid");
  }
  const virtualRetryDelaysSeconds = [];
  const callbackDelivery = await sendReleaseCallback({
    payload: {
      releaseRequestId: identity.releaseRequestId,
      releaseSequence: identity.releaseSequence,
      channel: "production",
      manifestSha256: identity.manifestSha256,
      idempotencyKey: `${identity.releaseRequestId}:${identity.releaseSequence}:${identity.manifestSha256}`,
      validatorStatus: "PASS",
      routeRegressionStatus: "PASS",
      publishStatus: "PASS",
      callbackVerifier: { value: "isolated-rehearsal-signature" },
    },
    endpoint: "http://127.0.0.1:1/admin/api/datapack/release-callbacks",
    token: "isolated-rehearsal-token",
    retryDelaysSeconds: RETRY_DELAYS_SECONDS,
    sleep: async (seconds) => virtualRetryDelaysSeconds.push(seconds),
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  if (callbackDelivery.state !== "RECONCILIATION_REQUIRED") {
    throw new Error("callback outage did not require reconciliation");
  }
  return {
    schemaVersion: 1,
    artifactKind: "callback-backend-unavailable-rehearsal",
    deliveryIdentity: { ...identity },
    candidate: { channel: "production", noChange: false },
    callbackDelivery,
    virtualRetryDelaysSeconds,
    sensitiveMaterialStored: false,
  };
}

async function main() {
  const outputIndex = process.argv.indexOf("--output");
  const output = process.argv[outputIndex + 1];
  if (outputIndex < 0 || !output || process.argv.length !== 4) {
    throw new Error("--output is required");
  }
  const result = await simulateCallbackBackendUnavailable({
    releaseRequestId: process.env.EASYSUBWAY_CALLBACK_EVIDENCE_RELEASE_REQUEST_ID,
    releaseSequence: Number(process.env.EASYSUBWAY_CALLBACK_EVIDENCE_RELEASE_SEQUENCE),
    manifestSha256: process.env.EASYSUBWAY_CALLBACK_EVIDENCE_MANIFEST_SHA256,
  });
  await writeFile(path.resolve(output), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
