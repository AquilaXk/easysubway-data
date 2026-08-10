#!/usr/bin/env node
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  sha256,
  signingKeyId,
  signingPublicKey,
  validateArtifactComponentManifest,
  verifyRsaSha256Signature,
  withoutSignature,
} from "./lib/manifest-validation.mjs";
import { rsaSha256Signature, signingPrivateKey } from "./lib/manifest-signing.mjs";

const COMPONENTS = ["accessibility", "fare", "timetable", "topology"];
const PAYLOAD_FILES = COMPONENTS.map((component) => `${component}.sqlite.zst`);
const KEYLESS_ROOT_FILES = ["compatibility.json", "manifest.signing-input.json", "payload", "provenance.json"];
const SIGNED_ROOT_FILES = ["compatibility.json", "manifest.json", "manifest.signing-input.json", "payload", "provenance.json"];
const SIGNATURE_ALGORITHM = "rsa-sha256-server-route-bundle-v1";

export async function signServerRouteBundle(input) {
  const inputRoot = await realDirectory(input.input, "input");
  const output = path.resolve(requiredRaw(input.output, "output"));
  await requireNewOutput(output);
  const outputParent = await realDirectory(path.dirname(output), "output parent");
  const artifact = await inspectArtifact(inputRoot, false);

  const signature = rsaSha256Signature(signingPrivateKey(), artifact.signingInputBytes);
  if (!verifyRsaSha256Signature(signingPublicKey(), artifact.signingInputBytes, signature)) {
    throw new Error("generated signature verification failed");
  }
  const manifest = {
    ...artifact.signingInput,
    signature: { algorithm: SIGNATURE_ALGORITHM, value: signature },
  };
  validateArtifactComponentManifest(manifest);
  const manifestBytes = Buffer.from(canonicalJson(manifest));

  const temp = await mkdtemp(path.join(outputParent, ".signed-route-bundle-"));
  try {
    await mkdir(path.join(temp, "payload"));
    for (const [relative, bytes] of artifact.files) {
      await writeFile(path.join(temp, relative), bytes, { flag: "wx" });
    }
    await writeFile(path.join(temp, "manifest.json"), manifestBytes, { flag: "wx" });
    const signed = await inspectArtifact(temp, true);
    if (!signed.manifestBytes.equals(manifestBytes)) throw new Error("signed manifest bytes changed before publication");
    await rename(temp, output);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }

  return { manifestSha256: sha256(manifestBytes) };
}

export async function inspectSignedServerRouteBundle(input) {
  const root = await realDirectory(input, "signed artifact root");
  const artifact = await inspectArtifact(root, true);
  return {
    root,
    manifest: artifact.manifest,
    manifestBytes: artifact.manifestBytes,
    signingInput: artifact.signingInput,
    signingInputBytes: artifact.signingInputBytes,
    files: [
      ...artifact.files,
      ["manifest.json", artifact.manifestBytes],
    ].sort(([left], [right]) => bytewise(left, right)),
  };
}

async function inspectArtifact(root, signed) {
  await assertDirectoryEntries(root, signed ? SIGNED_ROOT_FILES : KEYLESS_ROOT_FILES, signed ? "signed artifact file set" : "keyless artifact file set");
  const payloadRoot = await realDirectory(path.join(root, "payload"), "payload root");
  await assertDirectoryEntries(payloadRoot, PAYLOAD_FILES, "payload file set");
  const [signingInputBytes, provenanceBytes, compatibilityBytes, ...payloadBytes] = await Promise.all([
    readNonEmptyRegular(path.join(root, "manifest.signing-input.json"), "manifest signing input"),
    readNonEmptyRegular(path.join(root, "provenance.json"), "provenance"),
    readNonEmptyRegular(path.join(root, "compatibility.json"), "compatibility"),
    ...COMPONENTS.map((component) => readNonEmptyRegular(
      path.join(payloadRoot, `${component}.sqlite.zst`),
      `${component} payload`,
    )),
  ]);
  const signingInput = parseCanonicalJson(signingInputBytes, "manifest signing input");
  if (signingInput.keyId !== signingKeyId()) throw new Error("signing keyId mismatch");
  validateArtifactComponentManifest({
    ...signingInput,
    signature: { algorithm: SIGNATURE_ALGORITHM, value: "AA" },
  });
  validateDigests({ signingInput, provenanceBytes, compatibilityBytes, payloadBytes });

  let manifest = null;
  let manifestBytes = null;
  if (signed) {
    manifestBytes = await readNonEmptyRegular(path.join(root, "manifest.json"), "signed manifest");
    manifest = parseCanonicalJson(manifestBytes, "signed manifest");
    validateArtifactComponentManifest(manifest);
    if (!Buffer.from(canonicalJson(withoutSignature(manifest))).equals(signingInputBytes)) {
      throw new Error("signed manifest does not match signing input");
    }
    if (manifest.keyId !== signingKeyId()) throw new Error("signed manifest keyId mismatch");
    if (manifest.signature.algorithm !== SIGNATURE_ALGORITHM
      || !verifyRsaSha256Signature(signingPublicKey(), signingInputBytes, manifest.signature.value)) {
      throw new Error("signed manifest signature mismatch");
    }
  }

  return {
    manifest,
    signingInput,
    signingInputBytes,
    manifestBytes,
    files: [
      ["compatibility.json", compatibilityBytes],
      ["manifest.signing-input.json", signingInputBytes],
      ...COMPONENTS.map((component, index) => [`payload/${component}.sqlite.zst`, payloadBytes[index]]),
      ["provenance.json", provenanceBytes],
    ],
  };
}

function validateDigests({ signingInput, provenanceBytes, compatibilityBytes, payloadBytes }) {
  if (signingInput.provenanceSha256 !== sha256(provenanceBytes)) throw new Error("provenance digest mismatch");
  if (signingInput.compatibilitySha256 !== sha256(compatibilityBytes)) throw new Error("compatibility digest mismatch");
  const inventory = COMPONENTS.map((component, index) => ({
    path: `payload/${component}.sqlite.zst`,
    sizeBytes: payloadBytes[index].length,
    sha256: sha256(payloadBytes[index]),
  })).sort((left, right) => bytewise(left.path, right.path));
  for (const component of COMPONENTS) {
    if (signingInput[`${component}Sha256`] !== inventory.find((entry) => entry.path === `payload/${component}.sqlite.zst`).sha256) {
      throw new Error(`${component} payload digest mismatch`);
    }
  }
  if (signingInput.payloadSha256 !== sha256(Buffer.from(canonicalJson(inventory)))) {
    throw new Error("payload inventory digest mismatch");
  }
}

async function assertDirectoryEntries(root, expected, label) {
  const actual = (await readdir(root)).sort(bytewise);
  const wanted = [...expected].sort(bytewise);
  if (canonicalJson(actual) !== canonicalJson(wanted)) throw new Error(`${label} mismatch`);
}

async function readNonEmptyRegular(target, label) {
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink`);
  if (stat.size === 0) throw new Error(`${label} must be non-empty`);
  return readFile(target);
}

function parseCanonicalJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${label} must be JSON`);
  }
  if (!Buffer.from(bytes).equals(Buffer.from(canonicalJson(value)))) {
    throw new Error(`${label} must be canonical JSON`);
  }
  return value;
}

async function realDirectory(target, label) {
  const resolved = path.resolve(requiredRaw(target, label));
  let stat;
  try {
    stat = await lstat(resolved);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return resolved;
}

async function requireNewOutput(output) {
  try {
    await lstat(output);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("output must not already exist");
}

function requiredRaw(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty exact string`);
  }
  return value;
}

function bytewise(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    const normalized = key.slice(2);
    if (!new Set(["input", "output"]).has(normalized) || Object.hasOwn(args, normalized)) {
      throw new Error(`unsupported or duplicate argument: ${key}`);
    }
    args[normalized] = value;
  }
  if (Object.keys(args).length !== 2) throw new Error("exact --input and --output arguments are required");
  return args;
}

async function main(argv) {
  const { manifestSha256 } = await signServerRouteBundle(parseArgs(argv));
  process.stdout.write(`SIGNED ${manifestSha256}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`sign-server-route-bundle: ${error.message}\n`);
    process.exitCode = 1;
  });
}
