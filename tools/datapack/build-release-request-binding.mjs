#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, withoutSignature } from "./lib/manifest-validation.mjs";
import { rsaSha256Signature, signingPrivateKey } from "./lib/manifest-signing.mjs";
import { parseArgs, requiredArg } from "./lib/cli-args.mjs";

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
  const manifestBytes = await readFile(path.resolve(requiredArg(args, "manifest")));
  const binding = buildReleaseRequestBinding(
    manifestBytes,
    requiredArg(args, "release-request-id"),
    signingPrivateKey(),
    process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID?.trim() || "production-v1",
    args.get("release-outcome") ?? "PUBLISHED_AND_VERIFIED",
  );
  await writeFile(path.resolve(requiredArg(args, "output")), `${JSON.stringify(binding, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
