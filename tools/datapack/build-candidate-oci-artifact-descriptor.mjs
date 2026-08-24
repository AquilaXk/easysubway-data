#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, link, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export async function buildCandidateOciArtifactDescriptor(input) {
  const root = await realDirectory(input.root, "root");
  const files = Object.fromEntries(await Promise.all(["tuple", "inventory", "component"].map(async (name) => [name, await containedRegular(root, input[name], name)])));
  const output = path.resolve(requireString(input.output, "output"));
  if (isWithin(root, output)) throw new Error("descriptor output must be outside stage root");
  await absent(output, "output");
  const repository = exact(input.repository, "repository", "AquilaXk/easysubway-data");
  const workflowRunId = decimal(input.workflowRunId, "workflowRunId");
  const headSha = gitSha(input.headSha, "headSha");
  const namespace = segment(input.namespace, "namespace"); const bucket = segment(input.bucket, "bucket");
  const createdAt = utc(input.createdAt, "createdAt");
  const [tupleBytes, inventoryBytes, componentBytes] = await Promise.all([readFile(files.tuple), readFile(files.inventory), readFile(files.component)]);
  const tuple = tupleValue(parse(tupleBytes, "tuple")); const inventory = inventoryValue(parse(inventoryBytes, "inventory")); const component = componentValue(parse(componentBytes, "component"));
  if (component.repository !== repository || component.gitSha !== headSha || component.workflowRunId !== workflowRunId) throw new Error("component producer identity mismatch");
  if (component.manifestSha256 !== tuple.candidateBinding.manifestSha256 || component.artifactInventorySha256 !== sha256(inventoryBytes)) throw new Error("component tuple/inventory binding mismatch");
  const now = Date.parse(createdAt); const fresh = Date.parse(tuple.freshnessExpiresAt); if (fresh <= now) throw new Error("candidate freshness is expired");
  const expiresAt = new Date(Math.min(now + 14 * 24 * 60 * 60 * 1000, fresh)).toISOString();
  const actual = await stageEntries(root);
  for (const entry of actual) {
    if (new Set(["release-evidence-bundle.json", "release-decision.json", "final-release-decision.json", "launch-denominator-report.json", "publish-plan.json", "release-request-binding.json"]).has(path.posix.basename(entry.path))) {
      throw new Error(`candidate stage must not contain release evidence: ${entry.path}`);
    }
  }
  const metadata = new Map([[relative(root, files.inventory), fileEntry(relative(root, files.inventory), inventoryBytes)], [relative(root, files.component), fileEntry(relative(root, files.component), componentBytes)]]);
  const declared = new Map(inventory.entries.map((entry) => [entry.path, entry]));
  for (const [key, entry] of metadata) { if (declared.has(key)) throw new Error(`inventory must exclude metadata: ${key}`); declared.set(key, entry); }
  if (declared.size !== actual.length) throw new Error("inventory does not bind every staged object");
  for (const entry of actual) { const expected = declared.get(entry.path); if (!expected || expected.sizeBytes !== entry.sizeBytes || expected.sha256 !== entry.sha256) throw new Error(`stage object binding mismatch: ${entry.path}`); }
  const prefix = `candidates/v1/runs/${workflowRunId}/heads/${headSha}/candidates/${tuple.candidateBinding.candidateId}/`;
  const objects = actual.sort(byPath).map((entry) => ({ ...entry, objectKey: `${prefix}objects/${entry.sha256}/${entry.path}`, ociUri: `oci://${namespace}/${bucket}/${prefix}objects/${entry.sha256}/${entry.path}` }));
  const descriptor = { schemaVersion: 1, artifactKind: "datapack-candidate-oci-artifact-descriptor", repository, workflowRunId, headSha, artifactName: `easysubway-datapack-candidate-${workflowRunId}`, candidateBinding: tuple.candidateBinding, freshnessExpiresAt: tuple.freshnessExpiresAt, createdAt, expiresAt, inventory: fileEntry(relative(root, files.inventory), inventoryBytes), component: fileEntry(relative(root, files.component), componentBytes), tuple: fileEntry(relative(root, files.tuple), tupleBytes), objects };
  await atomicCreate(path.dirname(output), output, jsonBytes(descriptor));
  return descriptor;
}

function tupleValue(value) { exactKeys(value, ["candidateBinding", "freshnessExpiresAt"], "tuple"); exactKeys(value.candidateBinding, ["candidateId", "buildSpecSha256", "manifestSha256"], "tuple.candidateBinding"); return { candidateBinding: { candidateId: token(value.candidateBinding.candidateId, "candidateId"), buildSpecSha256: hash(value.candidateBinding.buildSpecSha256, "buildSpecSha256"), manifestSha256: hash(value.candidateBinding.manifestSha256, "manifestSha256") }, freshnessExpiresAt: utc(value.freshnessExpiresAt, "freshnessExpiresAt") }; }
function inventoryValue(value) { exactKeys(value, ["schemaVersion", "artifactKind", "entries"], "inventory"); if (value.schemaVersion !== 1 || value.artifactKind !== "datapack-candidate-inventory" || !Array.isArray(value.entries) || value.entries.length === 0) throw new Error("inventory is invalid"); const entries = value.entries.map((entry) => { exactKeys(entry, ["path", "sizeBytes", "sha256"], "inventory entry"); return fileEntry(safePath(entry.path), { length: positive(entry.sizeBytes, "inventory size"), sha256: hash(entry.sha256, "inventory sha") }); }); if (new Set(entries.map((entry) => entry.path)).size !== entries.length || entries.some((entry, index) => index && byPath(entries[index - 1], entry) >= 0)) throw new Error("inventory entries must be unique and ordered"); return { entries }; }
function componentValue(value) { const expected = ["schemaVersion", "component", "repository", "gitSha", "workflowRunId", "dataVersion", "releaseSequence", "manifestSha256", "provenance", "artifactInventorySha256", "contractVersion", "issueRef"]; exactKeys(value, expected, "component"); if (value.schemaVersion !== 1 || value.component !== "data") throw new Error("component is invalid"); return { repository: exact(value.repository, "component.repository", "AquilaXk/easysubway-data"), gitSha: gitSha(value.gitSha, "component.gitSha"), workflowRunId: decimal(value.workflowRunId, "component.workflowRunId"), manifestSha256: hash(value.manifestSha256, "component.manifestSha256"), artifactInventorySha256: hash(value.artifactInventorySha256, "component.artifactInventorySha256") }; }
async function stageEntries(root) { const entries = []; async function walk(directory) { for (const item of await readdir(directory, { withFileTypes: true })) { const target = path.resolve(directory, item.name); if (!isWithin(root, target)) throw new Error("stage traversal"); if (item.isSymbolicLink()) throw new Error("stage symlink"); if (item.isDirectory()) await walk(target); else if (item.isFile()) { const bytes = await readFile(target); if (bytes.length === 0) throw new Error("stage object must be non-empty"); entries.push(fileEntry(relative(root, target), bytes)); } else throw new Error("stage object must be regular file"); } } await walk(root); return entries; }
async function realDirectory(value, label) { const target = path.resolve(requireString(value, label)); const stat = await lstat(target); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be real directory`); return target; }
async function containedRegular(root, value, label) { const target = path.resolve(requireString(value, label)); if (!isWithin(root, target)) throw new Error(`${label} must be contained`); const stat = await lstat(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be regular`); return target; }
async function absent(file, label) { try { await lstat(file); } catch (error) { if (error.code === "ENOENT") return; throw error; } throw new Error(`${label} must be absent`); }
async function atomicCreate(parent, output, bytes) { const directory = await realDirectory(parent, "output parent"); const tmp = await mkdtemp(path.join(directory, ".candidate-oci-descriptor-")); try { const candidate = path.join(tmp, "descriptor.json"); await writeFile(candidate, bytes, { flag: "wx" }); await link(candidate, output); } finally { await rm(tmp, { recursive: true, force: true }); } }
function parse(bytes, label) { try { const value = JSON.parse(bytes.toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; } catch { throw new Error(`${label} must be JSON object`); } }
function fileEntry(file, bytes) { return { path: safePath(file), sizeBytes: bytes.length, sha256: bytes.sha256 ?? sha256(bytes) }; }
function exactKeys(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(`${label} fields must be exact`); }
function isWithin(root, target) { const relative = path.relative(root, target); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function relative(root, target) { return safePath(path.relative(root, target).split(path.sep).join("/")); }
function safePath(value) { const result = requireString(value, "path"); if (path.posix.isAbsolute(result) || result.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("unsafe path"); return result; }
function requireString(value, label) { if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new Error(`${label} is required`); return value; }
function exact(value, label, expected) { if (value !== expected) throw new Error(`${label} is invalid`); return value; }
function token(value, label) { const result = requireString(value, label); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result)) throw new Error(`${label} invalid`); return result; }
function segment(value, label) { const result = requireString(value, label); if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(result)) throw new Error(`${label} invalid`); return result; }
function decimal(value, label) { const result = requireString(value, label); if (!/^[1-9][0-9]*$/.test(result)) throw new Error(`${label} invalid`); return result; }
function gitSha(value, label) { const result = requireString(value, label); if (!/^[a-f0-9]{40}$/.test(result)) throw new Error(`${label} invalid`); return result; }
function hash(value, label) { const result = requireString(value, label); if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label} invalid`); return result; }
function positive(value, label) { if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} invalid`); return value; }
function utc(value, label) { const result = requireString(value, label); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || new Date(result).toISOString() !== result) throw new Error(`${label} invalid`); return result; }
function byPath(a, b) { return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)); }

if (import.meta.url === `file://${process.argv[1]}`) { const args = new Map(); for (let index = 2; index < process.argv.length; index += 2) { const key = process.argv[index]; const value = process.argv[index + 1]; if (!key?.startsWith("--") || value === undefined || args.has(key)) throw new Error("invalid arguments"); args.set(key, value); } await buildCandidateOciArtifactDescriptor({ root: args.get("--root"), tuple: args.get("--tuple"), inventory: args.get("--inventory"), component: args.get("--component"), repository: args.get("--repository"), workflowRunId: args.get("--workflow-run-id"), headSha: args.get("--head-sha"), namespace: args.get("--namespace"), bucket: args.get("--bucket"), createdAt: args.get("--created-at"), output: args.get("--output") }); }
