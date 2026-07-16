#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  signingKeyId,
  signingPublicKey,
  verifyRsaSha256Signature,
  withoutSignature,
} from "./lib/manifest-validation.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(requireArg(args, "manifest"));
  const root = path.resolve(requireArg(args, "root"));
  const outputPath = path.resolve(requireArg(args, "output"));
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  validateManifestShape(manifest);

  const only = args.get("only");
  if (only) {
    if (only !== "release-request-binding" || !args.has("release-request-binding")) {
      throw new Error("--only release-request-binding requires --release-request-binding");
    }
    const plan = {
      schemaVersion: 3,
      mode: "object-storage-preflight",
      manifestObjectKey: "catalog/current.json",
      steps: await releaseRequestBindingSteps(args, root, manifest, manifestBytes),
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (args.has("release-request-binding")) {
    throw new Error("release request binding requires --only release-request-binding after final validation");
  }

  const packPlans = [];
  for (const pack of manifest.packs) {
    const stagedPath = stagedPackPathForUrl(pack);
    const bytes = await readFile(path.join(root, stagedPath));
    if (bytes.length !== pack.sizeBytes) {
      throw new Error(`${pack.id}@${pack.version} sizeBytes mismatch: ${bytes.length}`);
    }

    const checksum = sha256(bytes);
    if (checksum !== pack.sha256) {
      throw new Error(`${pack.id}@${pack.version} compressed checksum mismatch: ${checksum}`);
    }

    packPlans.push({
      packId: pack.id,
      packVersion: pack.version,
      sourcePath: stagedPath,
      objectKey: stagedPath,
      sha256: pack.sha256,
      sizeBytes: pack.sizeBytes,
    });
  }

  const currentManifestPath = args.has("current-manifest")
    ? path.resolve(args.get("current-manifest"))
    : manifestPath;
  const currentManifestBytes = currentManifestPath === manifestPath
    ? manifestBytes
    : await readFile(currentManifestPath);

  const releaseSequence = manifest.releaseSequence;
  const includeReleaseManifest = Number.isInteger(releaseSequence) && releaseSequence >= 1;
  const releaseSteps = includeReleaseManifest
    ? [
        {
          type: "put-release-manifest-object",
          sourcePath: "catalog/current.json",
          objectKey: `catalog/releases/${releaseSequence}.json`,
          sha256: sha256(manifestBytes),
          sizeBytes: manifestBytes.length,
          packCount: manifest.packs.length,
          immutable: true,
        },
        {
          type: "verify-release-manifest-object",
          objectKey: `catalog/releases/${releaseSequence}.json`,
          sha256: sha256(manifestBytes),
          sizeBytes: manifestBytes.length,
          packCount: manifest.packs.length,
          immutable: true,
        },
      ]
    : [];

  const plan = {
    schemaVersion: includeReleaseManifest ? 2 : 1,
    mode: "object-storage-preflight",
    manifestObjectKey: "catalog/current.json",
    steps: [
      ...packPlans.map((packPlan) => ({ type: "put-pack-object", ...packPlan })),
      ...packPlans.map((packPlan) => ({
        type: "verify-pack-object",
        packId: packPlan.packId,
        packVersion: packPlan.packVersion,
        objectKey: packPlan.objectKey,
        sha256: packPlan.sha256,
        sizeBytes: packPlan.sizeBytes,
      })),
      ...releaseSteps,
      {
        type: "put-manifest-object",
        sourcePath: "catalog/current.json",
        objectKey: "catalog/current.json",
        sha256: sha256(currentManifestBytes),
        sizeBytes: currentManifestBytes.length,
        packCount: manifest.packs.length,
      },
      {
        type: "verify-manifest-object",
        objectKey: "catalog/current.json",
        sha256: sha256(currentManifestBytes),
        sizeBytes: currentManifestBytes.length,
        packCount: manifest.packs.length,
      },
    ],
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
}

async function releaseRequestBindingSteps(args, root, manifest, manifestBytes) {
  const bindingPath = path.resolve(args.get("release-request-binding"));
  const bindingBytes = await readFile(bindingPath);
  const binding = JSON.parse(bindingBytes.toString("utf8"));
  validateReleaseRequestBinding(binding, manifest, manifestBytes);
  const sourcePath = safeRelativeObjectPath(path.relative(root, bindingPath), "release request binding path");
  const objectKey = `catalog/release-requests/${sha256(Buffer.from(binding.releaseRequestId, "utf8"))}.json`;
  return [
    {
      type: "put-release-request-binding-object",
      sourcePath,
      objectKey,
      sha256: sha256(bindingBytes),
      sizeBytes: bindingBytes.length,
      immutable: true,
    },
    {
      type: "verify-release-request-binding-object",
      objectKey,
      sha256: sha256(bindingBytes),
      sizeBytes: bindingBytes.length,
      immutable: true,
    },
  ];
}

function validateReleaseRequestBinding(binding, manifest, manifestBytes) {
  if (binding?.schemaVersion !== 1
    || binding.artifactKind !== "datapack-release-request-binding"
    || typeof binding.releaseRequestId !== "string"
    || binding.releaseRequestId.length === 0
    || binding.releaseSequence !== manifest.releaseSequence
    || binding.channel !== manifest.channel
    || binding.manifestSha256 !== sha256(manifestBytes)
    || typeof binding.keyId !== "string"
    || binding.keyId.length === 0
    || binding.keyId !== signingKeyId()
    || !["PUBLISHED_AND_VERIFIED", "NO_CHANGE_VALID"].includes(binding.releaseOutcome)
    || binding.signature?.algorithm !== "rsa-sha256-release-request-v1"
    || typeof binding.signature?.value !== "string"
    || binding.signature.value.length === 0) {
    throw new Error("release request binding keyId or manifest identity does not match configured signer");
  }
  if (!verifyRsaSha256Signature(
    signingPublicKey(),
    canonicalJson(withoutSignature(binding)),
    binding.signature.value,
  )) {
    throw new Error("release request binding signature is invalid");
  }
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    const normalizedKey = key.slice(2);
    if (args.has(normalizedKey)) {
      throw new Error(`duplicate argument: ${key}`);
    }
    args.set(normalizedKey, value);
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

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.packs) || manifest.packs.length === 0) {
    throw new Error("manifest.packs must be a non-empty array");
  }
}

function stagedPackPath(pack) {
  const id = requiredSafePathSegment(pack.id, "pack.id");
  const version = requiredSafePathSegment(pack.version, "pack.version");
  return `catalog/${id}-v${version}.sqlite.gz`;
}

function stagedPackPathForUrl(pack) {
  const packUrl = requiredString(pack.url ?? stagedPackPath(pack), "pack.url");
  if (/^https:\/\//.test(packUrl)) {
    return stagedPackPath(pack);
  }
  return safeRelativeObjectPath(packUrl, "pack.url");
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function safeRelativeObjectPath(value, label) {
  if (/%[0-9a-f]{2}/i.test(value)) {
    throw new Error(`${label} must be a safe relative path or absolute HTTPS URL`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    throw new Error(`${label} must be a safe relative path or absolute HTTPS URL`);
  }
  if (value.split("/").includes("..")) {
    throw new Error(`${label} must be a safe relative path or absolute HTTPS URL`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${label} must be a safe relative path or absolute HTTPS URL`);
  }
  return normalized;
}

function requiredSafePathSegment(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`${label} must be a safe object key segment`);
  }
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
