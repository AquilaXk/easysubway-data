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

async function setSecretWithGh({ serviceKey, env, spawnImpl }) {
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
    if (child == null || typeof child.once !== "function" || child.stdin == null || typeof child.stdin.end !== "function") {
      reject(new Error(FAILURE_MESSAGE));
      return;
    }
    const fail = () => reject(new Error(FAILURE_MESSAGE));
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (code === 0 && signal == null) resolve();
      else fail();
    });
    child.stdin.once?.("error", fail);
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
} = {}) {
  requireNoArguments(argv);
  const serviceKey = requiredCanonicalServiceKey(env);
  await setSecretWithGh({ serviceKey, env, spawnImpl });
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
