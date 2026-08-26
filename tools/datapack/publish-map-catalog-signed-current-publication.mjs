import { createHash } from "node:crypto";
import { lstat, link, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, signingPublicKey, verifyRsaSha256Signature } from "./lib/manifest-validation.mjs";
import { createMapCatalogOciPublisher, createMapCatalogOciS3CompatTransport, putCreateOnlyAndFullGet } from "./lib/map-catalog-oci-publisher.mjs";
import { buildMapCatalogSignedCurrentOciPublicationReceipt } from "./build-map-catalog-signed-current-oci-publication-receipt.mjs";
import { rsaSha256Signature, signingPrivateKey } from "./lib/manifest-signing.mjs";
import { validateMapCatalogSignedCurrentPublication } from "./validate-map-catalog-signed-current-publication.mjs";

const MAP_PATHS = ["manifest.json", "payload/interchange-layout.json", "payload/line-styles.json", "payload/metropolitan.svg", "payload/stations-layout.json"];
const CATALOG_PATHS = ["manifest.json", "payload/catalog.sqlite"];

export async function publishMapCatalogSignedCurrentPublication({ artifactRoot, descriptorPath, receiptOutput, target, credentials, transport, operation, privateKey, publicKey, now = Date.now(), clock = () => Date.now(), beforeReceiptPersist } = {}) {
  if (beforeReceiptPersist !== undefined && typeof beforeReceiptPersist !== "function") throw new Error("beforeReceiptPersist must be a function");
  const startInstant = instant(now, "publication start instant");
  if (typeof clock !== "function") throw new Error("publication clock is invalid");
  const signing = validateSigningCapability(privateKey, publicKey);
  const local = await preflight({ artifactRoot, descriptorPath, receiptOutput, publicKey: signing.publicKey, now: startInstant });
  validateOperationIdentity(operation, local.descriptor);
  const publisher = createMapCatalogOciPublisher({ target, credentials, transport });
  const root = `${target.objectPrefix}/v1/content-descriptors/${local.descriptor.descriptorSha256}`;
  const objectReceipts = [];
  for (const item of local.objects) {
    const objectKey = `${root}/objects/${item.pack}/${item.path}`;
    objectReceipts.push({ pack: item.pack, path: item.path, objectKey, sizeBytes: item.bytes.length, sha256: item.sha256, fullGet: await putCreateOnlyAndFullGet(publisher, { key: objectKey, bytes: item.bytes }) });
  }
  const descriptorKey = `${target.objectPrefix}/v1/content-descriptors/${local.descriptor.descriptorSha256}.json`;
  const descriptorFullGet = await putCreateOnlyAndFullGet(publisher, { key: descriptorKey, bytes: local.descriptorBytes });
  const completedAt = instant(clock(), "publication completion instant");
  if (completedAt < startInstant) throw new Error("publication completion instant rolled back");
  const completedOperation = { ...operation, completedAt: new Date(completedAt).toISOString() };
  const stage = await mkdtemp(path.join(local.outputParent, ".map-catalog-publish-"));
  try {
    const stagedReceipt = path.join(stage, "receipt.json");
    const receipt = await buildMapCatalogSignedCurrentOciPublicationReceipt({ descriptor: local.descriptor, output: stagedReceipt, target, contentDescriptor: { objectKey: descriptorKey, sizeBytes: local.descriptorBytes.length, rawSha256: descriptorFullGet.sha256, fullGet: descriptorFullGet }, objects: objectReceipts, operation: completedOperation, privateKey: signing.privateKey, publicKey: signing.publicKey, now: completedAt });
    const receiptBytes = await readFile(stagedReceipt);
    const receiptObjectKey = `${target.objectPrefix}/v1/content-descriptors/${local.descriptor.descriptorSha256}/publication-receipts/${receipt.receiptSha256}.json`;
    await putCreateOnlyAndFullGet(publisher, { key: receiptObjectKey, bytes: receiptBytes });
    await persistReceipt(local, receiptBytes, beforeReceiptPersist);
    return { receipt, receiptObjectKey };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function publishMapCatalogSignedCurrentPublicationCli(argv = process.argv.slice(2), env = process.env, { clock = () => Date.now(), transport, privateKey, publicKey } = {}) {
  if (typeof clock !== "function") throw new Error("publication clock is invalid");
  const startInstant = instant(clock(), "publication start instant");
  const { artifactRoot, descriptorPath, receiptOutput } = cliArguments(argv);
  const target = {
    namespace: environment(env, "OCI_MAP_CATALOG_NAMESPACE"),
    bucket: environment(env, "OCI_MAP_CATALOG_BUCKET"),
    region: environment(env, "OCI_MAP_CATALOG_REGION"),
    compatEndpoint: environment(env, "OCI_MAP_CATALOG_COMPAT_ENDPOINT"),
    objectPrefix: environment(env, "OCI_MAP_CATALOG_OBJECT_PREFIX"),
  };
  const credentials = {
    accessKey: environment(env, "OCI_MAP_CATALOG_PUBLISHER_ACCESS_KEY"),
    secretKey: environment(env, "OCI_MAP_CATALOG_PUBLISHER_SECRET_KEY"),
  };
  const operation = {
    repository: environment(env, "GITHUB_REPOSITORY"),
    headSha: environment(env, "GITHUB_SHA"),
    workflowRunId: positiveEnvironment(env, "GITHUB_RUN_ID"),
    runAttempt: positiveEnvironment(env, "GITHUB_RUN_ATTEMPT"),
  };
  const publisherTransport = transport ?? createMapCatalogOciS3CompatTransport({ target, credentials });
  const result = await publishMapCatalogSignedCurrentPublication({ artifactRoot, descriptorPath, receiptOutput, target, credentials, transport: publisherTransport, operation, privateKey, publicKey, now: startInstant, clock });
  const descriptorSha256 = result.receipt.contentDescriptor.descriptorSha256;
  return {
    descriptorSha256,
    descriptorLocator: `oci://${target.namespace}/${target.bucket}/${target.objectPrefix}/v1/content-descriptors/${descriptorSha256}.json`,
    receiptSha256: result.receipt.receiptSha256,
    receiptLocator: `oci://${target.namespace}/${target.bucket}/${result.receiptObjectKey}`,
  };
}

export function formatMapCatalogOciPublicationHandoff({ descriptorSha256, descriptorLocator, receiptSha256, receiptLocator } = {}) {
  for (const value of [descriptorSha256, descriptorLocator, receiptSha256, receiptLocator]) if (typeof value !== "string" || value.length === 0) throw new Error("publication handoff is invalid");
  return `DESCRIPTOR_SHA ${descriptorSha256}\nDESCRIPTOR_LOCATOR ${descriptorLocator}\nRECEIPT_SHA ${receiptSha256}\nRECEIPT_LOCATOR ${receiptLocator}\n`;
}

async function preflight({ artifactRoot, descriptorPath, receiptOutput, publicKey, now }) {
  const root = await realDirectory(artifactRoot, "artifact root");
  const descriptorBytes = await regularFile(descriptorPath, "descriptor");
  const descriptor = parseCanonical(descriptorBytes, "descriptor");
  const content = validateMapCatalogSignedCurrentPublication(descriptor, { publicKey, now });
  if (!descriptorBytes.equals(Buffer.from(canonicalJson(content)))) throw new Error("descriptor bytes are noncanonical");
  const [mapPack, stationCatalogPack] = await Promise.all([readPack(root, "map-pack", MAP_PATHS), readPack(root, "station-catalog-pack", CATALOG_PATHS)]);
  if (canonicalJson(mapPack.descriptor) !== canonicalJson(content.mapPack) || canonicalJson(stationCatalogPack.descriptor) !== canonicalJson(content.stationCatalogPack)) throw new Error("local object inventory drift");
  const output = required(receiptOutput, "receipt output"); if (output.split(path.sep).includes("..")) throw new Error("receipt output traversal is invalid");
  const outputParent = await realDirectory(path.dirname(output), "receipt output parent"); const outputPath = path.join(outputParent, path.basename(output)); await absent(outputPath);
  return { descriptor: content, descriptorBytes, objects: [...mapPack.objects, ...stationCatalogPack.objects], outputParent, outputPath };
}

async function readPack(root, name, paths) {
  const pack = await realDirectory(path.join(root, name), `${name} root`); await exactEntries(pack, ["manifest.json", "payload"], `${name} root`); await exactEntries(path.join(pack, "payload"), paths.filter((item) => item.startsWith("payload/")).map((item) => item.slice(8)), `${name} payload`);
  const bytes = new Map(); for (const item of paths) bytes.set(item, await regularWithin(pack, item, `${name} ${item}`));
  const manifest = parseCanonical(bytes.get("manifest.json"), `${name} manifest`);
  const objects = paths.map((item) => ({ pack: name, path: item, bytes: bytes.get(item), sizeBytes: bytes.get(item).length, sha256: createHash("sha256").update(bytes.get(item)).digest("hex") }));
  return { descriptor: { manifest, objects: objects.map(({ path: item, sizeBytes, sha256 }) => ({ path: item, sizeBytes, sha256 })) }, objects };
}

async function persistReceipt(local, bytes, beforeReceiptPersist) { const parent = await realDirectory(local.outputParent, "receipt output parent"); const output = path.join(parent, path.basename(local.outputPath)); if (parent !== local.outputParent || output !== local.outputPath) throw new Error("receipt output parent changed"); await absent(output); const stage = await mkdtemp(path.join(parent, ".map-catalog-receipt-")); try { const staged = path.join(stage, "receipt.json"); await writeFile(staged, bytes, { flag: "wx" }); await beforeReceiptPersist?.(); const revalidatedParent = await realDirectory(local.outputParent, "receipt output parent"); const revalidatedOutput = path.join(revalidatedParent, path.basename(local.outputPath)); if (revalidatedParent !== local.outputParent || revalidatedOutput !== local.outputPath) throw new Error("receipt output parent changed"); await absent(revalidatedOutput); await link(staged, revalidatedOutput); } finally { await rm(stage, { recursive: true, force: true }); } }
async function realDirectory(value, label) { const target = path.resolve(required(value, label)); const stat = await lstat(target); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory`); return realpath(target); }
async function regularFile(value, label) { const target = path.resolve(required(value, label)); const stat = await lstat(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) throw new Error(`${label} must be a regular file`); return readFile(target); }
async function regularWithin(root, relative, label) { let target = root; for (const segment of relative.split("/")) { if (!segment || segment === "." || segment === "..") throw new Error(`${label} path is unsafe`); target = path.join(target, segment); const stat = await lstat(target); if (stat.isSymbolicLink()) throw new Error(`${label} must not be symlinked`); } const stat = await lstat(target); if (!stat.isFile() || stat.size < 1 || !(await realpath(target)).startsWith(`${root}${path.sep}`)) throw new Error(`${label} must be regular`); return readFile(target); }
async function exactEntries(root, expected, label) { const actual = (await readdir(root)).sort(compareUtf8); const wanted = [...expected].sort(compareUtf8); if (canonicalJson(actual) !== canonicalJson(wanted)) throw new Error(`${label} entries mismatch`); }
async function absent(target) { try { await lstat(target); throw new Error("receipt output already exists"); } catch (error) { if (error?.code !== "ENOENT") throw error; } }
function validateOperationIdentity(value, descriptor) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 4 || value.repository !== "AquilaXk/easysubway-data" || value.headSha !== descriptor.producerGitSha || !/^[a-f0-9]{40}$/u.test(value.headSha) || !Number.isSafeInteger(value.workflowRunId) || value.workflowRunId < 1 || !Number.isSafeInteger(value.runAttempt) || value.runAttempt < 1) throw new Error("operation identity mismatch"); }
function parseCanonical(bytes, label) { let value; try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} must be JSON`); } if (!value || typeof value !== "object" || Array.isArray(value) || !bytes.equals(Buffer.from(canonicalJson(value)))) throw new Error(`${label} must be canonical JSON`); return value; }
function required(value, label) { if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`); return value; }
function validateSigningCapability(privateKey, publicKey) { const resolvedPrivateKey = privateKey === undefined ? signingPrivateKey() : privateKey; const resolvedPublicKey = publicKey === undefined ? signingPublicKey() : publicKey; try { const probe = "map-catalog-signed-current-oci-publication-receipt-v1"; const signature = rsaSha256Signature(resolvedPrivateKey, probe); if (!verifyRsaSha256Signature(resolvedPublicKey, probe, signature)) throw new Error("signature mismatch"); } catch { throw new Error("signing key capability mismatch"); } return { privateKey: resolvedPrivateKey, publicKey: resolvedPublicKey }; }
function rfc3339(value) { const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u.exec(value); if (!match) return NaN; const [, year, month, day, hour, minute, second, fraction = "", zone] = match; const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number); const ms = Number(fraction.slice(0, 3).padEnd(3, "0")); const calendar = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms)); if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59 || calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== mo - 1 || calendar.getUTCDate() !== d || (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))) return NaN; return Date.parse(value); }
function cliArguments(argv) { if (!Array.isArray(argv) || argv.length !== 6) throw new Error("usage: --artifact-root <root> --descriptor <descriptor> --receipt-output <output>"); const values = new Map(); for (let index = 0; index < argv.length; index += 2) { const flag = argv[index]; if (!["--artifact-root", "--descriptor", "--receipt-output"].includes(flag) || values.has(flag) || typeof argv[index + 1] !== "string" || !argv[index + 1]) throw new Error("usage: --artifact-root <root> --descriptor <descriptor> --receipt-output <output>"); values.set(flag, argv[index + 1]); } return { artifactRoot: values.get("--artifact-root"), descriptorPath: values.get("--descriptor"), receiptOutput: values.get("--receipt-output") }; }
function environment(env, name) { const value = env?.[name]; if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new Error(`${name} is required`); return value; }
function positiveEnvironment(env, name) { const value = environment(env, name); if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} must be a positive integer`); return Number(value); }
function instant(value, label) { if (!Number.isFinite(value) || Number.isNaN(new Date(value).getTime())) throw new Error(`${label} is invalid`); return value; }
function compareUtf8(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }

if (import.meta.url === `file://${process.argv[1]}`) {
  publishMapCatalogSignedCurrentPublicationCli().then((result) => {
    process.stdout.write(formatMapCatalogOciPublicationHandoff(result));
  }).catch((error) => {
    process.stderr.write(`publish-map-catalog-signed-current-publication: ${error.message}\n`);
    process.exitCode = 1;
  });
}
