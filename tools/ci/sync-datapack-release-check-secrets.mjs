import { createPrivateKey, createPublicKey } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeDataGoKrServiceKey } from "../datapack/lib/provider-call-integrity.mjs";
import { syncGhSecret } from "./lib/sync-gh-secret.mjs";

const FAILURE_MESSAGE = "Data Pack candidate secret synchronization failed";
const REPOSITORY = "AquilaXk/easysubway-data";
const GH_REPOSITORY = "github.com/AquilaXk/easysubway-data";
const ENVIRONMENT = "datapack-release-check";
const SECRET_NAMES = Object.freeze([
  "EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM",
  "EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM",
  "EASYSUBWAY_DATAPACK_SIGNING_KEY_ID",
  "EASYSUBWAY_SEOUL_TOPIS_SERVICE_KEY",
  "DATA_GO_KR_SERVICE_KEY",
  "KRIC_SERVICE_KEY",
]);

function fail() {
  throw new Error(FAILURE_MESSAGE);
}

function singleLine(value) {
  return typeof value === "string" && value.length > 0
    && !value.includes("\n") && !value.includes("\r") && !value.includes("\0");
}

function validatedSecrets(argv, env) {
  if (!Array.isArray(argv) || argv.length !== 0) fail();
  if (!env || typeof env !== "object") fail();

  const values = Object.fromEntries(SECRET_NAMES.map((name) => [name, env[name]]));
  try {
    const privateKey = createPrivateKey(values.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM);
    let publicSlotContainsPrivateKey = true;
    try {
      createPrivateKey(values.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM);
    } catch {
      publicSlotContainsPrivateKey = false;
    }
    if (publicSlotContainsPrivateKey) fail();
    const publicKey = createPublicKey(values.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM);
    const derivedPublic = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    const configuredPublic = publicKey.export({ type: "spki", format: "der" });
    if (!derivedPublic.equals(configuredPublic)) fail();

    if (!singleLine(values.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID)
      || !singleLine(values.EASYSUBWAY_SEOUL_TOPIS_SERVICE_KEY)) fail();
    values.DATA_GO_KR_SERVICE_KEY = normalizeDataGoKrServiceKey(
      values.DATA_GO_KR_SERVICE_KEY,
      { label: "DATA_GO_KR_SERVICE_KEY" },
    );
    values.KRIC_SERVICE_KEY = normalizeDataGoKrServiceKey(
      values.KRIC_SERVICE_KEY,
      { label: "KRIC_SERVICE_KEY" },
    );
  } catch {
    fail();
  }
  return values;
}

export async function syncDatapackReleaseCheckSecrets({
  argv = process.argv.slice(2),
  env = process.env,
  syncImpl = syncGhSecret,
} = {}) {
  const values = validatedSecrets(argv, env);
  try {
    for (const secretName of SECRET_NAMES) {
      await syncImpl({
        secretName,
        ghRepository: GH_REPOSITORY,
        environment: ENVIRONMENT,
        serviceKey: values[secretName],
        failureMessage: FAILURE_MESSAGE,
        env,
      });
    }
  } catch {
    fail();
  }
  return {
    repository: REPOSITORY,
    environment: ENVIRONMENT,
    secretNames: [...SECRET_NAMES],
  };
}

async function main() {
  const result = await syncDatapackReleaseCheckSecrets();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(`${FAILURE_MESSAGE}\n`);
    process.exitCode = 1;
  });
}
