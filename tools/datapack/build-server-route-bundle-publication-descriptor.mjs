import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  prepareServerRouteBundlePublication,
  validateServerRouteBundlePublicationFacts,
} from "./build-server-route-bundle-consumer-handoff.mjs";
import {
  canonicalJson,
  sha256,
} from "./lib/manifest-validation.mjs";

const REPOSITORY = "AquilaXk/easysubway-data";
const DESCRIPTOR_KEYS = [
  "schemaVersion",
  "artifactKind",
  "producer",
  "manifest",
  "sourceSnapshotSetHash",
  "publicationReceipt",
  "release",
  "descriptorSha256",
];

export async function buildServerRouteBundlePublicationDescriptor(input) {
  const prepared = await prepareServerRouteBundlePublication(input, "descriptor");
  const payload = canonicalObject({
    schemaVersion: 2,
    artifactKind: "server-route-bundle-publication-descriptor",
    producer: prepared.producer,
    manifest: prepared.manifest,
    sourceSnapshotSetHash: prepared.sourceSnapshotSetHash,
    publicationReceipt: prepared.publicationReceipt,
    release: prepared.release,
  });
  const descriptor = validateServerRouteBundlePublicationDescriptor(canonicalObject({
    ...payload,
    descriptorSha256: sha256(Buffer.from(canonicalJson(payload))),
  }));
  await prepared.persist(Buffer.from(canonicalJson(descriptor)));
  return descriptor;
}

export function validateServerRouteBundlePublicationDescriptor(value) {
  assertKeys(value, DESCRIPTOR_KEYS, "descriptor keys");
  if (value.schemaVersion !== 2) throw new Error("descriptor schemaVersion must be 2");
  if (value.artifactKind !== "server-route-bundle-publication-descriptor") {
    throw new Error("descriptor artifactKind mismatch");
  }
  assertKeys(value.producer, ["repository", "gitSha"], "producer keys");
  if (value.producer.repository !== REPOSITORY || !/^[a-f0-9]{40}$/.test(value.producer.gitSha)) {
    throw new Error("producer identity mismatch");
  }
  const facts = validateServerRouteBundlePublicationFacts({
    manifest: value.manifest,
    sourceSnapshotSetHash: value.sourceSnapshotSetHash,
    publicationReceipt: value.publicationReceipt,
    release: value.release,
  }, "descriptor");
  if (value.producer.repository !== facts.publicationReceipt.repository.name
    || value.producer.gitSha !== facts.publicationReceipt.repository.gitSha) {
    throw new Error("producer identity mismatch");
  }
  if (typeof value.descriptorSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(value.descriptorSha256)) {
    throw new Error("descriptorSha256 must be sha256");
  }
  const payload = structuredClone(value);
  delete payload.descriptorSha256;
  if (value.descriptorSha256 !== sha256(Buffer.from(canonicalJson(payload)))) {
    throw new Error("descriptorSha256 mismatch");
  }
  return canonicalObject(value);
}

export function canonicalServerRouteBundlePublicationDescriptorJson(value) {
  return canonicalJson(validateServerRouteBundlePublicationDescriptor(value));
}

function assertKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  const wanted = new Set(expected);
  if (actual.length !== wanted.size || actual.some((key) => !wanted.has(key))) {
    throw new Error(`${label} mismatch`);
  }
}

function canonicalObject(value) {
  return JSON.parse(canonicalJson(value));
}

function parseArgs(argv) {
  const result = {};
  const allowed = new Set([
    "artifact-root",
    "final",
    "output",
    "promotion-request",
    "publication-receipt",
    "repository-git-sha",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "end"}`);
    }
    const name = key.slice(2);
    if (!allowed.delete(name)) throw new Error(`unknown or duplicate argument --${name}`);
    result[name] = value;
  }
  return result;
}

function requiredArg(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new Error(`--${name} must be a non-empty exact string`);
  }
  return value;
}

async function main(argv) {
  const args = parseArgs(argv);
  const descriptor = await buildServerRouteBundlePublicationDescriptor({
    repositoryRoot: process.cwd(),
    repositoryGitSha: requiredArg(args, "repository-git-sha"),
    artifactRoot: requiredArg(args, "artifact-root"),
    finalPath: requiredArg(args, "final"),
    publicationReceiptPath: requiredArg(args, "publication-receipt"),
    promotionRequestPath: requiredArg(args, "promotion-request"),
    output: requiredArg(args, "output"),
  });
  process.stdout.write(`DESCRIPTOR ${descriptor.descriptorSha256}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build-server-route-bundle-publication-descriptor: ${error.message}\n`);
    process.exitCode = 1;
  });
}
