import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { normalizeDataGoKrServiceKey } from "../datapack/lib/provider-call-integrity.mjs";
import {
  createSecretSyncError,
  formatSecretSyncReasonLine,
  recordFailureReason,
  SECRET_SYNC_REASON,
} from "./failure-reason.mjs";
import { syncGhSecret } from "./lib/sync-gh-secret.mjs";

const SECRET_NAME = "DATA_GO_KR_SERVICE_KEY";
const REPOSITORY = "AquilaXk/easysubway-data";
const GH_REPOSITORY = "github.com/AquilaXk/easysubway-data";
const ENVIRONMENT = "itx-current-collection";
const FAILURE_MESSAGE = "ITX current collection secret synchronization failed";

function fail(reason, secret) {
  throw createSecretSyncError(FAILURE_MESSAGE, reason, secret);
}

function requireNoArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    fail(SECRET_SYNC_REASON.ARGUMENT_INVALID);
  }
}

function requiredCanonicalServiceKey(env) {
  if (!env || typeof env !== "object") {
    fail(SECRET_SYNC_REASON.ARGUMENT_INVALID);
  }
  const serviceKey = env[SECRET_NAME];
  try {
    normalizeDataGoKrServiceKey(serviceKey, { label: SECRET_NAME });
  } catch {
    fail(SECRET_SYNC_REASON.SECRET_INVALID, SECRET_NAME);
  }
  return serviceKey;
}

export async function syncItxCurrentCollectionSecret({
  argv = process.argv.slice(2),
  env = process.env,
  syncImpl = syncGhSecret,
  spawnImpl = spawn,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  requireNoArguments(argv);
  if (typeof syncImpl !== "function" || typeof spawnImpl !== "function") {
    fail(SECRET_SYNC_REASON.ARGUMENT_INVALID);
  }
  const serviceKey = requiredCanonicalServiceKey(env);
  try {
    await syncImpl({
      secretName: SECRET_NAME,
      ghRepository: GH_REPOSITORY,
      environment: ENVIRONMENT,
      serviceKey,
      failureMessage: FAILURE_MESSAGE,
      env,
      spawnImpl,
      setTimeoutImpl,
      clearTimeoutImpl,
    });
  } catch {
    fail(SECRET_SYNC_REASON.GH_SYNC_FAILED, SECRET_NAME);
  }
  return {
    secretName: SECRET_NAME,
    repository: REPOSITORY,
    environment: ENVIRONMENT,
  };
}

async function main() {
  const result = await syncItxCurrentCollectionSecret();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const reasonLine = formatSecretSyncReasonLine(error, [SECRET_NAME]);
    recordFailureReason(reasonLine, { env: process.env });
    process.stderr.write(`${FAILURE_MESSAGE}\n${reasonLine}\n`);
    process.exitCode = 1;
  });
}
