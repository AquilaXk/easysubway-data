#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const execFile = promisify(execFileCallback);
const REPOSITORY = "AquilaXk/easysubway-data";
const PROVIDER_WORKFLOW = "KRIC EXIT Path Provider Snapshot";
const PROVIDER_WORKFLOW_PATH = ".github/workflows/kric-exit-path-provider-snapshot.yml@main";
const BUNDLE_NAME = "current-kric-exit-collection-bundle.json";
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const OUTPUT_FILES = new Set(["exit-path-normalized-source-snapshot.json", "exit-path-source-admission.json"]);

export async function runCurrentKricExitPathSourceAdmission({
  event,
  token,
  workspace,
  outputDirectory,
  fetchImpl = fetch,
  execFileImpl = execFile,
}) {
  const run = validateEvent(event);
  if (typeof token !== "string" || token.trim() === "") throw new Error("GITHUB_TOKEN is required");
  const root = requireAbsolutePath(workspace, "workspace");
  const output = requireAbsolutePath(outputDirectory, "output directory");
  await outputMustBeAbsent(output);

  const artifactsUrl = `https://api.github.com/repos/${REPOSITORY}/actions/runs/${run.id}/artifacts?per_page=100&page=1`;
  const artifactsResponse = await githubFetch(fetchImpl, artifactsUrl, token);
  const metadata = validateArtifactMetadata(await parseJsonResponse(artifactsResponse), run);
  const archiveUrl = `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${metadata.id}/zip`;
  const archive = await downloadGitHubArchive(fetchImpl, archiveUrl, token);
  if (sha256(archive) !== metadata.digest) throw new Error("artifact archive digest mismatch");
  const bundle = extractCurrentKricExitCollectionBundle(archive);

  const staging = await mkdtemp(path.join(path.dirname(output), ".kric-exit-bundle-"));
  const bundlePath = path.join(staging, BUNDLE_NAME);
  try {
    await writeFile(bundlePath, bundle, { mode: 0o600, flag: "wx" });
    const args = [
      "tools/datapack/build-current-exit-path-source-admission.mjs",
      "--collection-bundle", bundlePath,
      "--expected-bundle-sha256", sha256(bundle),
      "--expected-repository-sha", run.headSha,
      "--expected-workflow-run-id", String(run.id),
      "--facility-admission", path.join(root, "tools/datapack/release/current-capital-facility-source-admission.json"),
      "--candidate-build-spec", path.join(root, "tools/datapack/release/candidate-build-spec.json"),
      "--source-inventory", path.join(root, "tools/datapack/source-inventory.json"),
      "--source-snapshots", path.join(root, "tools/datapack/release/source-snapshots.json"),
      "--observed-at", run.updatedAt,
      "--output-directory", output,
    ];
    await execFileImpl(process.execPath, args, { cwd: root, env: { PATH: process.env.PATH ?? "" } });
    await verifyAdmissionOutput(output);
  } catch (error) {
    await rm(output, { force: true, recursive: true });
    throw error;
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

export function extractCurrentKricExitCollectionBundle(archive) {
  if (!Buffer.isBuffer(archive) || archive.length < 22 || archive.length > MAX_ARCHIVE_BYTES) {
    throw new Error("artifact archive size mismatch");
  }
  const eocdOffset = findEocd(archive);
  const entries = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (entries !== 1 || centralOffset + centralSize !== eocdOffset) throw new Error("archive must contain exactly one ZIP entry");
  if (archive.readUInt16LE(eocdOffset + 20) !== 0) throw new Error("ZIP comment is unsupported");
  const central = parseCentralEntry(archive, centralOffset, centralSize);
  if (central.name !== BUNDLE_NAME) throw new Error("ZIP entry name mismatch");
  if ((central.flags & ~0x0808) !== 0 || ![0, 8].includes(central.method)) throw new Error("ZIP entry flags or compression mismatch");
  if ((central.versionMadeBy >>> 8) !== 3 || ((central.externalAttributes >>> 16) & 0o170000) !== 0o100000) {
    throw new Error("ZIP entry must be regular");
  }
  const local = parseLocalEntry(archive, central.localOffset);
  if (local.name !== central.name || local.flags !== central.flags || local.method !== central.method) {
    throw new Error("ZIP local/central entry mismatch");
  }
  if (central.size === 0 || central.size > MAX_BUNDLE_BYTES || central.compressedSize > MAX_ARCHIVE_BYTES) {
    throw new Error("ZIP entry size mismatch");
  }
  const payloadStart = local.payloadOffset;
  const descriptorLength = (central.flags & 0x0008) === 0 ? 0 : descriptorSize(archive, centralOffset, central);
  const payloadEnd = centralOffset - descriptorLength;
  if (payloadEnd < payloadStart || ((central.flags & 0x0008) === 0
    && (local.crc !== central.crc || local.compressedSize !== central.compressedSize || local.size !== central.size
      || payloadStart + local.compressedSize !== payloadEnd))) {
    throw new Error("ZIP archive layout mismatch");
  }
  if (payloadEnd - payloadStart !== central.compressedSize) throw new Error("ZIP compressed size mismatch");
  const compressed = archive.subarray(payloadStart, payloadEnd);
  let bundle;
  try {
    bundle = local.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_BUNDLE_BYTES });
  } catch {
    throw new Error("ZIP payload decode failed");
  }
  if (bundle.length !== central.size || crc32(bundle) !== central.crc) throw new Error("ZIP CRC or size mismatch");
  return bundle;
}

function validateEvent(value) {
  const run = value?.workflow_run;
  if (value?.repository?.full_name !== REPOSITORY || !run || typeof run !== "object") {
    throw new Error("workflow event repository mismatch");
  }
  if (!Number.isSafeInteger(run.id) || run.id <= 0 || run.name !== PROVIDER_WORKFLOW
    || run.path !== PROVIDER_WORKFLOW_PATH || run.event !== "workflow_dispatch" || run.head_branch !== "main"
    || run.conclusion !== "success" || !/^[a-f0-9]{40}$/.test(run.head_sha ?? "")) {
    throw new Error("workflow event identity mismatch");
  }
  const updatedAt = requireUtcInstant(run.updated_at, "workflow run updated_at");
  return { id: run.id, headSha: run.head_sha, updatedAt };
}

function validateArtifactMetadata(payload, run) {
  if (!payload || !Number.isSafeInteger(payload.total_count) || payload.total_count !== 1
    || !Array.isArray(payload.artifacts) || payload.artifacts.length !== 1) {
    throw new Error("workflow artifact selection mismatch");
  }
  const [artifact] = payload.artifacts;
  if (!Number.isSafeInteger(artifact?.id) || artifact.id <= 0 || artifact.name !== `kric-exit-path-provider-snapshot-${run.id}`
    || artifact.expired !== false || typeof artifact.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) {
    throw new Error("workflow artifact metadata mismatch");
  }
  return { id: artifact.id, digest: artifact.digest.slice("sha256:".length) };
}

async function githubFetch(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2026-03-10" },
    redirect: "manual",
  });
  if (!response || response.status < 200 || response.status >= 300) throw new Error("GitHub API request failed");
  return response;
}

async function downloadGitHubArchive(fetchImpl, url, token) {
  let response = await fetchImpl(url, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2026-03-10" },
    redirect: "manual",
  });
  if (response?.status >= 300 && response.status < 400) {
    const location = response.headers?.get?.("location");
    if (!isSignedArtifactStorageUrl(location)) throw new Error("artifact redirect is outside signed storage");
    response = await fetchImpl(location, { headers: { Accept: "application/octet-stream" }, redirect: "error" });
  }
  if (!response || response.status !== 200) throw new Error("artifact download failed");
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) throw new Error("artifact archive size mismatch");
  return archive;
}

function isSignedArtifactStorageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname.endsWith(".actions.githubusercontent.com")
      || url.hostname.endsWith(".blob.core.windows.net"));
  } catch { return false; }
}

async function parseJsonResponse(response) {
  try { return await response.json(); } catch { throw new Error("GitHub API JSON is invalid"); }
}

function findEocd(archive) {
  const start = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= start; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end record missing");
}

function parseCentralEntry(archive, offset, size) {
  if (size < 46 || offset < 0 || offset + size > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
    throw new Error("ZIP central entry mismatch");
  }
  const versionMadeBy = archive.readUInt16LE(offset + 4);
  const flags = archive.readUInt16LE(offset + 8);
  const method = archive.readUInt16LE(offset + 10);
  const crc = archive.readUInt32LE(offset + 16);
  const compressedSize = archive.readUInt32LE(offset + 20);
  const entrySize = archive.readUInt32LE(offset + 24);
  const nameLength = archive.readUInt16LE(offset + 28);
  const extraLength = archive.readUInt16LE(offset + 30);
  const commentLength = archive.readUInt16LE(offset + 32);
  const externalAttributes = archive.readUInt32LE(offset + 38);
  const localOffset = archive.readUInt32LE(offset + 42);
  if (46 + nameLength + extraLength + commentLength !== size || (flags & 0x0001) !== 0 || (flags & ~0x0808) !== 0) {
    throw new Error("ZIP central entry flags mismatch");
  }
  const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
  if (!Buffer.from(name, "utf8").equals(archive.subarray(offset + 46, offset + 46 + nameLength))) throw new Error("ZIP entry name encoding mismatch");
  return { versionMadeBy, flags, method, crc, compressedSize, size: entrySize, name, externalAttributes, localOffset };
}

function parseLocalEntry(archive, offset) {
  if (offset < 0 || offset + 30 > archive.length || archive.readUInt32LE(offset) !== 0x04034b50) throw new Error("ZIP local entry missing");
  const flags = archive.readUInt16LE(offset + 6);
  const method = archive.readUInt16LE(offset + 8);
  const crc = archive.readUInt32LE(offset + 14);
  const compressedSize = archive.readUInt32LE(offset + 18);
  const size = archive.readUInt32LE(offset + 22);
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const payloadOffset = offset + 30 + nameLength + extraLength;
  if (payloadOffset > archive.length || (flags & 0x0001) !== 0 || (flags & ~0x0808) !== 0) throw new Error("ZIP local entry flags mismatch");
  const nameBytes = archive.subarray(offset + 30, offset + 30 + nameLength);
  const name = nameBytes.toString("utf8");
  if (!Buffer.from(name, "utf8").equals(nameBytes)) throw new Error("ZIP entry name encoding mismatch");
  return { flags, method, crc, compressedSize, size, name, payloadOffset };
}

function descriptorSize(archive, centralOffset, central) {
  for (const size of [16, 12]) {
    const offset = centralOffset - size;
    if (offset < 0) continue;
    const hasSignature = size === 16 && archive.readUInt32LE(offset) === 0x08074b50;
    const valuesOffset = hasSignature ? offset + 4 : offset;
    if ((size === 16 ? hasSignature : archive.readUInt32LE(offset) !== 0x08074b50)
      && archive.readUInt32LE(valuesOffset) === central.crc
      && archive.readUInt32LE(valuesOffset + 4) === central.compressedSize
      && archive.readUInt32LE(valuesOffset + 8) === central.size) {
      return size;
    }
  }
  throw new Error("ZIP data descriptor mismatch");
}

async function verifyAdmissionOutput(output) {
  const entries = await readdir(output);
  if (entries.length !== OUTPUT_FILES.size || entries.some((entry) => !OUTPUT_FILES.has(entry))) throw new Error("EXIT admission output mismatch");
  for (const entry of entries) {
    const stat = await lstat(path.join(output, entry));
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.size === 0) {
      throw new Error("EXIT admission output integrity mismatch");
    }
  }
  let admission;
  try { admission = JSON.parse(await readFile(path.join(output, "exit-path-source-admission.json"), "utf8")); } catch {
    throw new Error("EXIT admission output is invalid JSON");
  }
  if (admission?.decision !== "GO") throw new Error("EXIT admission did not reach GO");
}

async function outputMustBeAbsent(output) {
  try { await lstat(output); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  throw new Error("output directory must be absent");
}

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(value);
}

function requireUtcInstant(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be UTC instant`);
  }
  return value;
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== "--event-path" || argv[2] !== "--output-directory") {
    throw new Error("usage: --event-path <absolute> --output-directory <absolute>");
  }
  return { eventPath: requireAbsolutePath(argv[1], "event path"), outputDirectory: requireAbsolutePath(argv[3], "output directory") };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const args = parseArgs(process.argv.slice(2));
  const event = JSON.parse(await readFile(args.eventPath, "utf8"));
  await runCurrentKricExitPathSourceAdmission({
    event,
    token: process.env.GITHUB_TOKEN,
    workspace: process.env.GITHUB_WORKSPACE,
    outputDirectory: args.outputDirectory,
  });
}
