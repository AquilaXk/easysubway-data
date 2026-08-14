import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { normalizeDataGoKrServiceKey } from "../datapack/lib/provider-call-integrity.mjs";
import { syncGhSecret } from "./lib/sync-gh-secret.mjs";

const SECRET_NAME = "KRIC_SERVICE_KEY";
const REPOSITORY = "AquilaXk/easysubway-data";
const GH_REPOSITORY = "github.com/AquilaXk/easysubway-data";
const FAILURE_MESSAGE = "KRIC EXIT diagnostic secret synchronization failed";

function requiredServiceKey(argv, env) {
  if (!Array.isArray(argv) || argv.length !== 0) throw new Error(FAILURE_MESSAGE);
  const serviceKey = env?.[SECRET_NAME];
  try {
    normalizeDataGoKrServiceKey(serviceKey, { label: SECRET_NAME });
  } catch {
    throw new Error(FAILURE_MESSAGE);
  }
  return serviceKey;
}

export async function syncKricExitDiagnosticSecret({
  argv = process.argv.slice(2),
  env = process.env,
  spawnImpl = spawn,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const serviceKey = requiredServiceKey(argv, env);
  await syncGhSecret({
    secretName: SECRET_NAME,
    ghRepository: GH_REPOSITORY,
    serviceKey,
    failureMessage: FAILURE_MESSAGE,
    env,
    spawnImpl,
    setTimeoutImpl,
    clearTimeoutImpl,
  });
  return { secretName: SECRET_NAME, repository: REPOSITORY };
}

async function main() {
  const result = await syncKricExitDiagnosticSecret();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(`${FAILURE_MESSAGE}\n`);
    process.exitCode = 1;
  });
}
