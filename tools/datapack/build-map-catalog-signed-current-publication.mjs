import { createHash } from "node:crypto";
import { lstat, link, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, signingKeyId, withoutSignature } from "./lib/manifest-validation.mjs";
import { rsaSha256Signature, signingPrivateKey } from "./lib/manifest-signing.mjs";
import { validateMapCatalogSignedCurrentPublication } from "./validate-map-catalog-signed-current-publication.mjs";

const MAP_PATHS = ["manifest.json", "payload/interchange-layout.json", "payload/line-styles.json", "payload/metropolitan.svg", "payload/stations-layout.json"];
const CATALOG_PATHS = ["manifest.json", "payload/catalog.sqlite"];
const ALGORITHM = "rsa-sha256-map-catalog-signed-current-v1";
const sha = (value) => createHash("sha256").update(value).digest("hex");

export async function buildMapCatalogSignedCurrentPublication({ artifactRoot, output, producerGitSha, releaseSequence, signedFinalDescriptorSha256, freshUntil, privateKey = signingPrivateKey(), publicKey, now = Date.now() } = {}) {
  const root = await directory(artifactRoot, "artifact root"); const rawOutput = required(output, "output");
  if (rawOutput.split(path.sep).includes("..")) throw new Error("output path traversal is invalid");
  const requested = path.resolve(rawOutput);
  if (requested.startsWith(`${root}${path.sep}`) || requested === root) throw new Error("output must be outside artifact root");
  await absent(requested);
  const [mapPack, stationCatalogPack] = await Promise.all([readPack(root, "map-pack", MAP_PATHS), readPack(root, "station-catalog-pack", CATALOG_PATHS)]);
  if (mapPack.manifest.stationSetSha256 !== stationCatalogPack.manifest.stationSetSha256) throw new Error("station set mismatch");
  const identity = { producerGitSha: requiredSha(producerGitSha, 40, "producerGitSha"), releaseSequence: positive(releaseSequence), signedFinalDescriptorSha256: requiredSha(signedFinalDescriptorSha256, 64, "signedFinalDescriptorSha256"), stationSetSha256: mapPack.manifest.stationSetSha256, freshUntil: fresh(freshUntil, now) };
  const receipt = sign({ schemaVersion: 1, artifactKind: "map-catalog-signed-current-publication-receipt", ...identity, mapPack, stationCatalogPack, receiptSha256: "" }, "receiptSha256", privateKey);
  const descriptor = sign({ schemaVersion: 1, artifactKind: "map-catalog-signed-current-publication", ...identity, mapPack, stationCatalogPack, publicationReceipt: receipt, publicationReceiptSha256: receipt.receiptSha256, descriptorSha256: "" }, "descriptorSha256", privateKey);
  validateMapCatalogSignedCurrentPublication(descriptor, { publicKey, now });
  await createNew(requested, Buffer.from(canonicalJson(descriptor)));
  return descriptor;
}

function sign(payload, digestField, privateKey) { const unsigned = { ...structuredClone(payload), keyId: signingKeyId() }; delete unsigned.signature; delete unsigned[digestField]; const bound = { ...unsigned, [digestField]: sha(Buffer.from(canonicalJson(unsigned))) }; return { ...bound, signature: { algorithm: ALGORITHM, value: rsaSha256Signature(privateKey, canonicalJson(bound)) } }; }
async function readPack(root, name, paths) { const pack = await directory(path.join(root, name), `${name} root`); await entries(pack, ["manifest.json", "payload"], `${name} root`); await entries(path.join(pack, "payload"), paths.filter((item) => item.startsWith("payload/")).map((item) => item.slice(8)), `${name} payload`); const files = new Map(); for (const relative of paths) files.set(relative, await regular(pack, relative, `${name} ${relative}`)); const manifestBytes = files.get("manifest.json"); let manifest; try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { throw new Error(`${name} manifest must be JSON`); } if (!Buffer.from(canonicalJson(manifest)).equals(manifestBytes)) throw new Error(`${name} manifest is noncanonical`); const objects = paths.map((relative) => ({ path: relative, sizeBytes: files.get(relative).length, sha256: sha(files.get(relative)) })); return { manifest, objects }; }
async function directory(value, label) { const target = path.resolve(required(value, label)); const stat = await lstat(target); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory`); return realpath(target); }
async function regular(root, relative, label) { let current = root; for (const segment of relative.split("/")) { if (!segment || segment === "." || segment === "..") throw new Error(`${label} path is unsafe`); current = path.join(current, segment); const stat = await lstat(current); if (stat.isSymbolicLink()) throw new Error(`${label} must not be symlinked`); } const stat = await lstat(current); if (!stat.isFile() || stat.size < 1 || !(await realpath(current)).startsWith(`${root}${path.sep}`)) throw new Error(`${label} must be regular`); return readFile(current); }
async function entries(root, expected, label) { const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0; const actual = (await readdir(root)).sort(compare); const wanted = [...expected].sort(compare); if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} entries mismatch`); }
async function absent(target) { try { await lstat(target); throw new Error("output already exists"); } catch (error) { if (error?.code !== "ENOENT") throw error; } }
async function createNew(target, bytes) { const parent = await directory(path.dirname(target), "output parent"); const stage = await mkdtemp(path.join(parent, ".map-catalog-publication-")); try { const file = path.join(stage, "descriptor.json"); await writeFile(file, bytes, { flag: "wx" }); await link(file, target); } finally { await rm(stage, { recursive: true, force: true }); } }
function required(value, label) { if (typeof value !== "string" || !value) throw new Error(`${label} is required`); return value; }
function requiredSha(value, length, label) { if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value)) throw new Error(`${label} is invalid`); return value; }
function positive(value) { if (!Number.isSafeInteger(value) || value < 1) throw new Error("releaseSequence is invalid"); return value; }
function fresh(value, now) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= now) throw new Error("freshUntil is invalid"); return value; }
