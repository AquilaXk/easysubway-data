import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertExactObjectKeys as assertKeys,
  canonicalJsonObject as canonicalObject,
  prepareServerRouteBundlePublication,
  runServerRouteBundlePublicationCli,
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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await runServerRouteBundlePublicationCli(process.argv.slice(2), {
    build: buildServerRouteBundlePublicationDescriptor,
    digestKey: "descriptorSha256",
    errorPrefix: "build-server-route-bundle-publication-descriptor",
    successLabel: "DESCRIPTOR",
  });
}
