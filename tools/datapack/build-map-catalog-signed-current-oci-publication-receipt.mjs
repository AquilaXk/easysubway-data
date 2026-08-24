import { createHash } from "node:crypto";
import { lstat, link, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, signingKeyId } from "./lib/manifest-validation.mjs";
import { rsaSha256Signature, signingPrivateKey } from "./lib/manifest-signing.mjs";
import { validateMapCatalogSignedCurrentPublication } from "./validate-map-catalog-signed-current-publication.mjs";
import { validateMapCatalogSignedCurrentOciPublicationReceipt } from "./validate-map-catalog-signed-current-oci-publication-receipt.mjs";

const ALGORITHM = "rsa-sha256-map-catalog-signed-current-v1";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function buildMapCatalogSignedCurrentOciPublicationReceipt({ descriptor, output, target, contentDescriptor, objects, operation, privateKey = signingPrivateKey(), publicKey, now = Date.now(), beforeCreate } = {}) {
  const content = validateMapCatalogSignedCurrentPublication(descriptor, { publicKey, now });
  if (beforeCreate !== undefined && typeof beforeCreate !== "function") throw new Error("beforeCreate must be a function");
  const rawOutput = required(output, "output");
  if (rawOutput.split(path.sep).includes("..")) throw new Error("output path traversal is invalid");
  const parent = await outputDirectory(path.dirname(rawOutput));
  const requested = path.join(parent, path.basename(rawOutput));
  await absent(requested);
  const receipt = sign({
    schemaVersion: 1,
    artifactKind: "map-catalog-signed-current-oci-publication-receipt",
    producerGitSha: content.producerGitSha,
    releaseSequence: content.releaseSequence,
    signedFinalDescriptorSha256: content.signedFinalDescriptorSha256,
    stationSetSha256: content.stationSetSha256,
    freshUntil: content.freshUntil,
    target: structuredClone(target),
    contentDescriptor: { descriptorSha256: content.descriptorSha256, ...structuredClone(contentDescriptor) },
    objects: structuredClone(objects),
    operation: structuredClone(operation),
  }, privateKey);
  validateMapCatalogSignedCurrentOciPublicationReceipt(receipt, { descriptor: content, publicKey, now });
  await createNew({ rawParent: path.dirname(rawOutput), parent, target: requested, bytes: Buffer.from(canonicalJson(receipt)), beforeCreate });
  return receipt;
}

function sign(payload, privateKey) { const unsigned = { ...payload, keyId: signingKeyId() }; const bound = { ...unsigned, receiptSha256: sha256(Buffer.from(canonicalJson(unsigned))) }; return { ...bound, signature: { algorithm: ALGORITHM, value: rsaSha256Signature(privateKey, canonicalJson(bound)) } }; }
async function outputDirectory(value) { const target = path.resolve(required(value, "output parent")); const resolved = await realpath(target); const stat = await lstat(resolved); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("output parent must be a regular directory"); return resolved; }
async function absent(target) { try { await lstat(target); throw new Error("output already exists"); } catch (error) { if (error?.code !== "ENOENT") throw error; } }
async function createNew({ rawParent, parent, target, bytes, beforeCreate }) { await beforeCreate?.(); const revalidatedParent = await outputDirectory(rawParent); const revalidatedTarget = path.join(revalidatedParent, path.basename(target)); if (revalidatedParent !== parent || revalidatedTarget !== target) throw new Error("output parent changed"); await absent(revalidatedTarget); const stage = await mkdtemp(path.join(revalidatedParent, ".map-catalog-oci-receipt-")); try { const file = path.join(stage, "receipt.json"); await writeFile(file, bytes, { flag: "wx" }); await link(file, revalidatedTarget); } finally { await rm(stage, { recursive: true, force: true }); } }
function required(value, label) { if (typeof value !== "string" || !value) throw new Error(`${label} is required`); return value; }
