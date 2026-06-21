#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(requireArg(args, "manifest"));
  const root = path.resolve(requireArg(args, "root"));
  const outputPath = path.resolve(requireArg(args, "output"));
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  validateManifestShape(manifest);

  const packPlans = [];
  for (const pack of manifest.packs) {
    const stagedPath = stagedPackPath(pack);
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

  const plan = {
    schemaVersion: 1,
    mode: "object-storage-preflight",
    manifestObjectKey: "catalog/current.json",
    steps: [
      ...packPlans.map((packPlan) => ({
        type: "put-pack-object",
        ...packPlan,
      })),
      ...packPlans.map((packPlan) => ({
        type: "verify-pack-object",
        packId: packPlan.packId,
        packVersion: packPlan.packVersion,
        objectKey: packPlan.objectKey,
        sha256: packPlan.sha256,
        sizeBytes: packPlan.sizeBytes,
      })),
      {
        type: "put-manifest-object",
        sourcePath: path.basename(manifestPath),
        objectKey: "catalog/current.json",
        sha256: sha256(manifestBytes),
        sizeBytes: manifestBytes.length,
        packCount: manifest.packs.length,
      },
    ],
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
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
