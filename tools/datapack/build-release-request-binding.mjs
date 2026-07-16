#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, withoutSignature } from "./lib/manifest-validation.mjs";
import { rsaSha256Signature, signingPrivateKey } from "./lib/manifest-signing.mjs";

export function buildReleaseRequestBinding(
  manifestBytes,
  releaseRequestId,
  privateKey,
  keyId,
  releaseOutcome = "PUBLISHED_AND_VERIFIED",
) {
  if (typeof releaseRequestId !== "string" || releaseRequestId.trim() === "") {
    throw new Error("releaseRequestId is required");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!Number.isSafeInteger(manifest.releaseSequence) || manifest.releaseSequence < 1) {
    throw new Error("manifest.releaseSequence must be a positive safe integer");
  }
  if (typeof manifest.channel !== "string" || manifest.channel.trim() === "") {
    throw new Error("manifest.channel is required");
  }
  if (typeof keyId !== "string" || keyId.trim() === "") throw new Error("keyId is required");
  if (!["PUBLISHED_AND_VERIFIED", "NO_CHANGE_VALID"].includes(releaseOutcome)) {
    throw new Error("releaseOutcome is invalid");
  }
  const unsigned = {
    schemaVersion: 1,
    artifactKind: "datapack-release-request-binding",
    releaseRequestId: releaseRequestId.trim(),
    releaseSequence: manifest.releaseSequence,
    channel: manifest.channel,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    keyId: keyId.trim(),
    releaseOutcome,
  };
  return {
    ...unsigned,
    signature: {
      algorithm: "rsa-sha256-release-request-v1",
      value: rsaSha256Signature(privateKey, canonicalJson(withoutSignature(unsigned))),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestBytes = await readFile(path.resolve(required(args, "manifest")));
  const binding = buildReleaseRequestBinding(
    manifestBytes,
    required(args, "release-request-id"),
    signingPrivateKey(),
    process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID?.trim() || "production-v1",
    args.get("release-outcome") ?? "PUBLISHED_AND_VERIFIED",
  );
  await writeFile(path.resolve(required(args, "output")), `${JSON.stringify(binding, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    if (args.has(key.slice(2))) throw new Error(`duplicate argument: ${key}`);
    args.set(key.slice(2), value);
  }
  return args;
}

function required(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
