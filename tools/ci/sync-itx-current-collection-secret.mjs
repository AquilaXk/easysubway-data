import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { normalizeDataGoKrServiceKey } from "../datapack/lib/provider-call-integrity.mjs";

const SECRET_NAME = "DATA_GO_KR_SERVICE_KEY";
const REPOSITORY = "AquilaXk/easysubway-data";
const GH_REPOSITORY = "github.com/AquilaXk/easysubway-data";
const ENVIRONMENT = "itx-current-collection";
const TIMEOUT_MS = 15_000;
const FAILURE_MESSAGE = "ITX current collection secret synchronization failed";

function requireNoArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new Error(FAILURE_MESSAGE);
  }
}

function requiredCanonicalServiceKey(env) {
  const serviceKey = env?.[SECRET_NAME];
  try {
    normalizeDataGoKrServiceKey(serviceKey, { label: SECRET_NAME });
  } catch {
    throw new Error(FAILURE_MESSAGE);
  }
  return serviceKey;
}

async function setSecretWithGh({ serviceKey, env, spawnImpl, setTimeoutImpl, clearTimeoutImpl }) {
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toUpperCase() !== SECRET_NAME),
  );

  let child;
  try {
    child = spawnImpl("gh", [
      "secret", "set", SECRET_NAME,
      "--repo", GH_REPOSITORY,
      "--env", ENVIRONMENT,
    ], {
      env: childEnv,
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: TIMEOUT_MS,
    });
  } catch {
    throw new Error(FAILURE_MESSAGE);
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    const finish = (succeeded) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeoutImpl(timeout);
      if (succeeded) resolve();
      else reject(new Error(FAILURE_MESSAGE));
    };
    if (child == null || typeof child.once !== "function" || child.stdin == null || typeof child.stdin.end !== "function") {
      finish(false);
      return;
    }
    const fail = () => finish(false);
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (code === 0 && signal == null) finish(true);
      else fail();
    });
    child.stdin.once?.("error", fail);
    try {
      timeout = setTimeoutImpl(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The failure result remains sanitized even when process termination itself fails.
        }
        fail();
      }, TIMEOUT_MS);
    } catch {
      fail();
      return;
    }
    try {
      child.stdin.end(serviceKey);
    } catch {
      fail();
    }
  });
}

export async function syncItxCurrentCollectionSecret({
  argv = process.argv.slice(2),
  env = process.env,
  spawnImpl = spawn,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  requireNoArguments(argv);
  const serviceKey = requiredCanonicalServiceKey(env);
  await setSecretWithGh({ serviceKey, env, spawnImpl, setTimeoutImpl, clearTimeoutImpl });
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
  main().catch(() => {
    process.stderr.write(`${FAILURE_MESSAGE}\n`);
    process.exitCode = 1;
  });
}
