#!/usr/bin/env node
import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const names = new Set(["root", "repo-root", "build-spec", "manifest", "provenance", "output", "now"]);

export async function buildDatapackCandidateTuple(input) {
  const root = await realDirectory(input.root, "--root");
  const repoRoot = await realDirectory(input.repoRoot, "--repo-root");
  const buildSpecPath = contained(repoRoot, input.buildSpec, "--build-spec");
  const manifestPath = contained(root, input.manifest, "--manifest");
  const provenancePath = contained(root, input.provenance, "--provenance");
  const output = contained(root, input.output, "--output");
  const now = instant(input.now, "--now");
  if (new Set([buildSpecPath, manifestPath, provenancePath, output]).size !== 4) throw new Error("tuple inputs and output must be distinct");
  const [buildSpecBytes, manifestBytes, provenanceBytes] = await Promise.all([
    regularBytes(buildSpecPath, "--build-spec"), regularBytes(manifestPath, "--manifest"), regularBytes(provenancePath, "--provenance"),
  ]);
  await assertAbsent(output, "--output");
  const buildSpec = json(buildSpecBytes, "--build-spec");
  const manifest = json(manifestBytes, "--manifest");
  const provenance = json(provenanceBytes, "--provenance");
  const tuple = validate({ buildSpec, manifest, provenance, buildSpecSha256: sha256(buildSpecBytes), manifestSha256: sha256(manifestBytes), now });
  await atomicCreate(root, output, Buffer.from(`${JSON.stringify(tuple, null, 2)}\n`));
  return tuple;
}

function validate({ buildSpec, manifest, provenance, buildSpecSha256, manifestSha256, now }) {
  if (buildSpec.schemaVersion !== 1 || buildSpec.artifactKind !== "datapack-candidate-build-spec") throw new Error("build spec is not a production candidate build spec");
  const candidateId = token(buildSpec.candidateId, "buildSpec.candidateId");
  const builderGitSha = gitSha(buildSpec.builderGitSha, "buildSpec.builderGitSha");
  const buildSnapshotIds = snapshotIds(buildSpec.sourceSnapshotIds, "buildSpec.sourceSnapshotIds");
  const buildSnapshots = snapshots(buildSpec.sourceSnapshots, "buildSpec.sourceSnapshots");
  if (!sameTokens(buildSnapshots.map(({ snapshotId }) => snapshotId), buildSnapshotIds)) throw new Error("buildSpec source snapshot identity mismatch");
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.manifestVersion !== 2) throw new Error("manifest must be production manifestVersion 2");
  const freshnessExpiresAt = utc(manifest.expiresAt, "manifest.expiresAt");
  if (Date.parse(freshnessExpiresAt) <= now) throw new Error("manifest candidate is expired");
  if (provenance.schemaVersion !== 1 || provenance.artifactKind !== "datapack-field-provenance") throw new Error("provenance artifact identity mismatch");
  if (hash(provenance.manifestSha256, "provenance.manifestSha256") !== manifestSha256) throw new Error("provenance manifest raw identity mismatch");
  const candidateBuild = provenance.candidateBuild;
  if (token(candidateBuild.candidateId, "provenance.candidateBuild.candidateId") !== candidateId) throw new Error("provenance candidate identity mismatch");
  if (gitSha(candidateBuild.builderGitSha, "provenance.candidateBuild.builderGitSha") !== builderGitSha) throw new Error("provenance builder git sha mismatch");
  if (hash(candidateBuild.buildSpecSha256, "provenance.candidateBuild.buildSpecSha256") !== buildSpecSha256) throw new Error("provenance build spec raw identity mismatch");
  if (!sameTokens(snapshotIds(candidateBuild.sourceSnapshotIds, "provenance.candidateBuild.sourceSnapshotIds"), buildSnapshotIds)) throw new Error("provenance source snapshot ids mismatch");
  const provenanceSnapshots = snapshots(candidateBuild.sourceSnapshots, "provenance.candidateBuild.sourceSnapshots");
  if (canonical(candidateBuild.sourceSnapshots) !== canonical(buildSpec.sourceSnapshots)) throw new Error("provenance source snapshot raw identity mismatch");
  for (const snapshot of provenanceSnapshots) if (Date.parse(snapshot.freshnessExpiresAt) < Date.parse(freshnessExpiresAt)) throw new Error("manifest expiry exceeds source freshness");
  const tuple = { candidateBinding: { candidateId, buildSpecSha256, manifestSha256 }, freshnessExpiresAt };
  // This is a cross-repository handoff, not an extensible release record.  Keep
  // its on-disk shape as narrow as the Hub consumer contract.
  exactKeys(tuple, ["candidateBinding", "freshnessExpiresAt"], "tuple");
  exactKeys(tuple.candidateBinding, ["candidateId", "buildSpecSha256", "manifestSha256"], "tuple.candidateBinding");
  return tuple;
}

function snapshots(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be non-empty`);
  const normalized = value.map((entry, index) => {
    exactKeys(entry, ["snapshotId", "sourceId", "rawSha256", "freshnessExpiresAt"], `${label}[${index}]`);
    return { snapshotId: token(entry.snapshotId, `${label}[${index}].snapshotId`), sourceId: token(entry.sourceId, `${label}[${index}].sourceId`), rawSha256: hash(entry.rawSha256, `${label}[${index}].rawSha256`), freshnessExpiresAt: utc(entry.freshnessExpiresAt, `${label}[${index}].freshnessExpiresAt`) };
  });
  if (new Set(normalized.map(({ snapshotId }) => snapshotId)).size !== normalized.length) throw new Error(`${label} snapshot IDs must be unique`);
  return normalized;
}

function snapshotIds(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be unique and non-empty`);
  const normalized = value.map((entry, index) => token(entry, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must be unique and non-empty`);
  return normalized;
}

function sameTokens(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

async function atomicCreate(root, output, bytes) {
  const temporary = await mkdtemp(path.join(root, ".datapack-candidate-tuple-"));
  const file = path.join(temporary, "tuple.json");
  try { await writeFile(file, bytes, { flag: "wx" }); await link(file, output); } finally { await rm(temporary, { recursive: true, force: true }); }
}
async function realDirectory(value, label) { const target = path.resolve(required(value, label)); const stat = await lstat(target); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`); return target; }
function contained(root, value, label) { const target = path.resolve(required(value, label)); const relative = path.relative(root, target); if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} must be inside --root`); return target; }
async function regularBytes(file, label) { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`); return readFile(file); }
async function assertAbsent(file, label) { try { await lstat(file); } catch (error) { if (error?.code === "ENOENT") return; throw error; } throw new Error(`${label} must not already exist`); }
function json(bytes, label) { try { const value = JSON.parse(bytes.toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; } catch { throw new Error(`${label} must contain a JSON object`); } }
function exactKeys(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); const actual = Object.keys(value).sort(compareUtf8); const expected = [...keys].sort(compareUtf8); if (actual.join("\u0000") !== expected.join("\u0000")) throw new Error(`${label} fields must be exact`); }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function required(value, label) { if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`); return value; }
function token(value, label) { const result = required(value, label); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result)) throw new Error(`${label} is invalid`); return result; }
function hash(value, label) { const result = required(value, label); if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label} must be sha256`); return result; }
function utc(value, label) { const result = required(value, label); const parsed = Date.parse(result); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) throw new Error(`${label} must be canonical UTC milliseconds`); return result; }
function instant(value, label) { const parsed = Date.parse(utc(value, label)); return parsed; }
function gitSha(value, label) { const result = required(value, label); if (!/^[a-f0-9]{40}$/.test(result)) throw new Error(`${label} must be a full lowercase git sha`); return result; }
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length !== names.size * 2) throw new Error("exactly the required arguments are required");
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) { const key = args[index]; const value = args[index + 1]; if (!key?.startsWith("--") || value === undefined || value.startsWith("--") || !names.has(key.slice(2)) || values.has(key)) throw new Error(`invalid argument: ${key}`); values.set(key, value); }
  await buildDatapackCandidateTuple({ root: values.get("--root"), repoRoot: values.get("--repo-root"), buildSpec: values.get("--build-spec"), manifest: values.get("--manifest"), provenance: values.get("--provenance"), output: values.get("--output"), now: values.get("--now") });
}
