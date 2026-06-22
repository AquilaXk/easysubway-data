#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";

const exportedNames = [
  "EASYSUBWAY_OBJECT_STORAGE_ENDPOINT",
  "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY",
  "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY",
  "EASYSUBWAY_OBJECT_STORAGE_REGION",
  "EASYSUBWAY_DATAPACK_BUCKET",
];
const maskedExportedNames = new Set([
  "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY",
  "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY",
  "EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL",
]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = requireArg(args, "env-file");
  const githubEnv = requireArg(args, "github-env");
  const githubOutput = requireArg(args, "github-output");
  const allowInvalidDisabled = args.has("allow-invalid-disabled");
  const env = parseDotenv(await readFile(envFile, "utf8"));

  if (env.EASYSUBWAY_DATAPACK_REMOTE_PUBLISH_ENABLED !== "true") {
    await disableRemotePublish(githubEnv, githubOutput);
    return;
  }

  try {
    requireHttpsPublicUrl(env.EASYSUBWAY_DATA_PACK_BASE_URL, "EASYSUBWAY_DATA_PACK_BASE_URL");
    if (env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL) {
      requireHttpsPublicUrl(
        env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL,
        "EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL",
      );
    } else {
      requireHttpsPublicUrl(env.EASYSUBWAY_OBJECT_STORAGE_ENDPOINT, "EASYSUBWAY_OBJECT_STORAGE_ENDPOINT");
      requireSafeSegment(env.EASYSUBWAY_DATAPACK_BUCKET, "EASYSUBWAY_DATAPACK_BUCKET");

      for (const name of exportedNames) {
        requireNonEmpty(env[name], name);
      }
    }
  } catch (error) {
    if (!allowInvalidDisabled) {
      throw error;
    }
    console.error(`remote publish disabled: ${error.message}`);
    await disableRemotePublish(githubEnv, githubOutput, { invalid: true });
    return;
  }

  const lines = [
    "EASYSUBWAY_DATAPACK_REMOTE_PUBLISH=enabled",
    ...(env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL
      ? [`EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL=${env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL}`]
      : exportedNames.map((name) => `${name}=${env[name]}`)),
  ];
  registerGithubMasks(env);
  await appendFile(githubEnv, `${lines.join("\n")}\n`);
  await appendFile(githubOutput, "enabled=true\n");
}

function registerGithubMasks(env) {
  for (const name of maskedExportedNames) {
    const value = env[name];
    if (value) {
      process.stdout.write(`::add-mask::${escapeGithubCommandValue(value)}\n`);
    }
  }
}

function escapeGithubCommandValue(value) {
  return String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

async function disableRemotePublish(githubEnv, githubOutput, { invalid = false } = {}) {
  await appendFile(githubEnv, "EASYSUBWAY_DATAPACK_REMOTE_PUBLISH=disabled\n");
  await appendFile(githubOutput, `enabled=false\n${invalid ? "invalid=true\n" : ""}`);
}

function parseDotenv(source) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) {
      continue;
    }
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) {
      continue;
    }
    values[match[1]] = unquote(match[2]);
  }
  return values;
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return value;
}

function requireHttpsPublicUrl(value, name) {
  requireNonEmpty(value, name);
  const url = new URL(value);
  if (url.protocol !== "https:" || isLocalHost(url.hostname)) {
    throw new Error(`${name} must be an HTTPS public URL`);
  }
  return url;
}

function isLocalHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost"
    || normalized === "::1"
    || normalized === "0.0.0.0"
    || normalized.startsWith("127.")
    || normalized.endsWith(".localhost")
  );
}

function requireSafeSegment(value, name) {
  requireNonEmpty(value, name);
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`${name} must be a safe object storage segment`);
  }
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--allow-invalid-disabled") {
      args.set("allow-invalid-disabled", true);
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    const normalized = key.slice(2);
    if (args.has(normalized)) {
      throw new Error(`duplicate argument: ${key}`);
    }
    args.set(normalized, value);
    index += 1;
  }
  return args;
}

function requireArg(args, name) {
  const value = args.get(name);
  if (!value) {
    throw new Error(`missing required argument: --${name}`);
  }
  return value;
}

function requireNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
